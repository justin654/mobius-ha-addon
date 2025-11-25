const fetch = require('node-fetch');
const mqtt = require('mqtt');

// Environment Variables
const MOBIUS_EMAIL = process.env.MOBIUS_EMAIL;
const MOBIUS_PASSWORD = process.env.MOBIUS_PASSWORD;
const MOBIUS_BASE_URL = process.env.MOBIUS_BASE_URL || 'https://cloud.mobius.app';
const POLL_INTERVAL = parseInt(process.env.MOBIUS_POLL_INTERVAL || '60', 10);
const MQTT_TOPIC_PREFIX = (process.env.MQTT_TOPIC_PREFIX || 'homeassistant').replace(/\/$/, '');
const DEBUG = process.env.MOBIUS_DEBUG === 'true';

// Constants
const USER_AGENT = 'Mobius/2.24; iPhone18,2 Version/26.2; Mobile';
const RADION_SCALE = 10;
const RADION_MODELS = [179];
const VORTECH_MODELS = [147];
const BASE_POLL_INTERVAL_MS = Math.max(5000, POLL_INTERVAL * 1000);
const MAX_BACKOFF_MS = Math.max(BASE_POLL_INTERVAL_MS * 4, 5 * 60 * 1000);

const RADION_SENSORS = [
    { key: 'point_intensity', channel: 1, name: 'Point Intensity', unit: '%' },
    { key: 'uv', channel: 21, name: 'UV', unit: '%' },
    { key: 'violet', channel: 23, name: 'Violet', unit: '%' },
    { key: 'royal_blue', channel: 18, name: 'Royal Blue', unit: '%' },
    { key: 'blue', channel: 17, name: 'Blue', unit: '%' },
    { key: 'green', channel: 19, name: 'Green', unit: '%' },
    { key: 'red', channel: 20, name: 'Red', unit: '%' },
    { key: 'warm_white', channel: 31, name: 'Warm White', unit: '%' },
    { key: 'cool_white', channel: 16, name: 'Cool White', unit: '%' },
];

const VORTECH_SENSORS = [
    { key: 'vortech_speed', name: 'Vortech Speed', unit: '%' },
    { key: 'vortech_mode', name: 'Vortech Mode', unit: null },
];

let authCookie = null;
let mqttConnected = false;
let shouldPoll = false;
let pollTimer = null;
let nextPollDelayMs = BASE_POLL_INTERVAL_MS;
let currentAvailability = null;

const discoveredRadions = new Set();
const discoveredVortechs = new Set();

// Logging
const log = (msg, ...args) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`, ...args);
const error = (msg, ...args) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, ...args);
const debug = (msg, ...args) => { if (DEBUG) console.log(`[${new Date().toISOString()}] DEBUG: ${msg}`, ...args); };

// Decoding Functions
function decodeRadionPoint(data) {
    if (!data) return {};
    try {
        const binary = Buffer.from(data, 'base64').toString('binary');
        const channels = {};
        
        for (let i = 0; i < binary.length; i += 3) {
            if (i + 2 >= binary.length) break;
            const channelId = binary.charCodeAt(i);
            const low = binary.charCodeAt(i + 1);
            const high = binary.charCodeAt(i + 2);
            const rawValue = low | (high << 8);
            const percent = Math.round((rawValue / RADION_SCALE) * 10) / 10;
            channels[channelId] = { percent, raw: rawValue };
        }
        return channels;
    } catch (err) {
        error('Radion decode failed:', err);
        return {};
    }
}

function decodePumpPoint(data) {
    if (!data) return null;
    try {
        const binary = Buffer.from(data, 'base64').toString('binary');
        if (binary.length < 2) return null;
        const val = (binary.charCodeAt(0) << 8) | binary.charCodeAt(1);
        return Math.round(val / 10.0 * 10) / 10;
    } catch (err) {
        error('Pump decode failed:', err);
        return null;
    }
}

// Utility helpers
const sanitizeId = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function getCurrentMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function selectSchedulePoint(points) {
    if (!Array.isArray(points) || points.length === 0) {
        return null;
    }
    const sorted = [...points].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    const minutes = getCurrentMinutes();

    let selected = sorted[sorted.length - 1];
    for (const point of sorted) {
        if (typeof point.time !== 'number') {
            continue;
        }
        if (minutes >= point.time) {
            selected = point;
        } else {
            break;
        }
    }
    return selected;
}

function getDeviceSlug(device) {
    const serial = device.serialNumber && device.serialNumber.trim();
    if (serial) {
        return sanitizeId(serial);
    }
    if (device.address && Array.isArray(device.address.bytes)) {
        return sanitizeId(Buffer.from(device.address.bytes).toString('hex'));
    }
    if (device.deviceId) {
        return sanitizeId(String(device.deviceId));
    }
    return `device-${Math.random().toString(36).slice(2, 10)}`;
}

function findDevices(config, modelIds) {
    const matches = [];
    (config.tanks || []).forEach((tank) => {
        (tank.devices || []).forEach((device) => {
            if (modelIds.includes(device.model)) {
                matches.push({ device, tank });
            }
        });
    });
    return matches;
}

function publishState(topic, payload) {
    mqttClient.publish(topic, payload, { retain: false });
}

function publishAvailability(online) {
    const payload = online ? 'online' : 'offline';
    if (currentAvailability === payload) return;
    currentAvailability = payload;
    mqttClient.publish(`${MQTT_TOPIC_PREFIX}/mobius/status`, payload, { retain: true });
}

function ensureRadionDiscovery(deviceId, device, tank) {
    if (discoveredRadions.has(deviceId)) {
        return;
    }
    discoveredRadions.add(deviceId);

    const friendlyName = (device.name && device.name.trim()) || `Radion ${device.serialNumber || deviceId}`;
    const deviceInfo = {
        identifiers: [`mobius_radion_${deviceId}`],
        name: friendlyName,
        manufacturer: 'EcoTech Marine',
        model: device.model ? `Model ${device.model}` : undefined,
        serial_number: device.serialNumber || undefined,
    };
    if (tank && tank.name) {
        deviceInfo.suggested_area = tank.name;
    }

    RADION_SENSORS.forEach((sensor) => {
        const topicBase = `${MQTT_TOPIC_PREFIX}/sensor/mobius_radion/${deviceId}/${sensor.key}`;
        const payload = {
            name: `${friendlyName} ${sensor.name}`,
            unique_id: `mobius_radion_${deviceId}_${sensor.key}`,
            state_topic: `${topicBase}/state`,
            availability_topic: `${MQTT_TOPIC_PREFIX}/mobius/status`,
            unit_of_measurement: sensor.unit,
            device: deviceInfo,
        };
        mqttClient.publish(`${topicBase}/config`, JSON.stringify(payload), { retain: true });
    });
}

function ensureVortechDiscovery(deviceId, device, tank) {
    if (discoveredVortechs.has(deviceId)) {
        return;
    }
    discoveredVortechs.add(deviceId);

    const friendlyName = (device.name && device.name.trim()) || `Vortech ${device.serialNumber || deviceId}`;
    const deviceInfo = {
        identifiers: [`mobius_vortech_${deviceId}`],
        name: friendlyName,
        manufacturer: 'EcoTech Marine',
        model: device.model ? `Model ${device.model}` : undefined,
        serial_number: device.serialNumber || undefined,
    };
    if (tank && tank.name) {
        deviceInfo.suggested_area = tank.name;
    }

    VORTECH_SENSORS.forEach((sensor) => {
        const topicBase = `${MQTT_TOPIC_PREFIX}/sensor/mobius_vortech/${deviceId}/${sensor.key}`;
        const payload = {
            name: `${friendlyName} ${sensor.name}`,
            unique_id: `mobius_vortech_${deviceId}_${sensor.key}`,
            state_topic: `${topicBase}/state`,
            availability_topic: `${MQTT_TOPIC_PREFIX}/mobius/status`,
            unit_of_measurement: sensor.unit,
            device: deviceInfo,
        };
        mqttClient.publish(`${topicBase}/config`, JSON.stringify(payload), { retain: true });
    });
}

function publishRadionState(deviceId, device) {
    const schedule = device.schedule || {};
    const points = schedule.points || [];
    let channels = null;

    const point = selectSchedulePoint(points);
    if (point && point.data) {
        channels = decodeRadionPoint(point.data);
    }

    RADION_SENSORS.forEach((sensor) => {
        const topic = `${MQTT_TOPIC_PREFIX}/sensor/mobius_radion/${deviceId}/${sensor.key}/state`;
        const entry = channels ? channels[sensor.channel] : null;
        const value = entry && typeof entry.percent === 'number' ? String(entry.percent) : 'unavailable';
        publishState(topic, value);
    });
}

function publishVortechState(deviceId, device) {
    const schedule = device.schedule || {};
    const points = schedule.points || [];
    const point = selectSchedulePoint(points);
    const speed = point && point.data ? decodePumpPoint(point.data) : null;
    const mode = (device.vectraInfo && device.vectraInfo.feedModeReturnDelay) ? 'Feed' : 'Run';

    publishState(
        `${MQTT_TOPIC_PREFIX}/sensor/mobius_vortech/${deviceId}/vortech_speed/state`,
        speed === null ? 'unavailable' : String(speed),
    );
    publishState(
        `${MQTT_TOPIC_PREFIX}/sensor/mobius_vortech/${deviceId}/vortech_mode/state`,
        mode,
    );
}

function markOfflineDevices(discoveredSet, activeSet, type) {
    const sensors = type === 'radion' ? RADION_SENSORS : VORTECH_SENSORS;
    discoveredSet.forEach((deviceId) => {
        if (activeSet.has(deviceId)) {
            return;
        }
        sensors.forEach((sensor) => {
            const topic = `${MQTT_TOPIC_PREFIX}/sensor/mobius_${type}/${deviceId}/${sensor.key}/state`;
            publishState(topic, 'unavailable');
        });
    });
}

// API Functions
async function login() {
    log('Logging in to Mobius...');
    
    // DEBUG: Check string length if needed (optional)
    // debug(`Email len: ${MOBIUS_EMAIL.length}, Pass len: ${MOBIUS_PASSWORD.length}`);

    const res = await fetch(`${MOBIUS_BASE_URL}/api/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT
        },
        body: JSON.stringify({
            user: MOBIUS_EMAIL,
            password: MOBIUS_PASSWORD
        })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Login failed (${res.status}): ${text}`);
    }

    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) {
        throw new Error('Login succeeded but no Set-Cookie header received');
    }

    const match = setCookie.match(/auth=([^;]+)/);
    if (!match) {
        throw new Error('No auth cookie found in Set-Cookie header');
    }

    authCookie = `auth=${match[1]}`;
    log('Login successful');
}

async function fetchConfig() {
    if (!authCookie) await login();

    let res = await fetch(`${MOBIUS_BASE_URL}/mobius/fs/config.json`, {
        headers: {
            'Cookie': authCookie,
            'User-Agent': USER_AGENT
        }
    });

    if (res.status === 401) {
        log('Session expired, re-logging...');
        authCookie = null;
        await login();
        res = await fetch(`${MOBIUS_BASE_URL}/mobius/fs/config.json`, {
            headers: {
                'Cookie': authCookie,
                'User-Agent': USER_AGENT
            }
        });
    }

    if (!res.ok) {
        throw new Error(`Config fetch failed (${res.status})`);
    }

    return res.json();
}

// MQTT
const mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT || 1883}`, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: 'mobius-ha-node',
    reconnectPeriod: 5000,
    will: {
        topic: `${MQTT_TOPIC_PREFIX}/mobius/status`,
        payload: 'offline',
        retain: true
    }
});

mqttClient.on('connect', () => {
    mqttConnected = true;
    log('MQTT Connected');
    publishAvailability(true);
    startPolling();
});

mqttClient.on('error', (err) => {
    error('MQTT Error:', err);
});
mqttClient.on('reconnect', () => log('MQTT reconnecting...'));
mqttClient.on('close', () => handleMqttDisconnect('connection closed'));
mqttClient.on('offline', () => handleMqttDisconnect('offline'));

async function processConfig(config) {
    const activeRadionIds = new Set();
    const activeVortechIds = new Set();

    const radions = findDevices(config, RADION_MODELS);
    radions.forEach(({ device, tank }) => {
        const deviceId = getDeviceSlug(device);
        activeRadionIds.add(deviceId);
        ensureRadionDiscovery(deviceId, device, tank);
        publishRadionState(deviceId, device);
    });

    const vortechs = findDevices(config, VORTECH_MODELS);
    vortechs.forEach(({ device, tank }) => {
        const deviceId = getDeviceSlug(device);
        activeVortechIds.add(deviceId);
        ensureVortechDiscovery(deviceId, device, tank);
        publishVortechState(deviceId, device);
    });

    markOfflineDevices(discoveredRadions, activeRadionIds, 'radion');
    markOfflineDevices(discoveredVortechs, activeVortechIds, 'vortech');
}

function scheduleNextPoll(success) {
    if (!shouldPoll) {
        return;
    }
    nextPollDelayMs = success ? BASE_POLL_INTERVAL_MS : Math.min(nextPollDelayMs * 2, MAX_BACKOFF_MS);
    debug(`Next poll in ${nextPollDelayMs / 1000}s`);
    pollTimer = setTimeout(poll, nextPollDelayMs);
}

async function poll() {
    if (!shouldPoll) {
        return;
    }
    try {
        const config = await fetchConfig();
        await processConfig(config);
        publishAvailability(true);
        nextPollDelayMs = BASE_POLL_INTERVAL_MS;
        scheduleNextPoll(true);
    } catch (err) {
        error('Polling failed:', err);
        publishAvailability(false);
        authCookie = null; // Clear session on error to force re-login
        scheduleNextPoll(false);
    }
}

function startPolling() {
    if (shouldPoll) {
        return;
    }
    shouldPoll = true;
    nextPollDelayMs = BASE_POLL_INTERVAL_MS;
    poll();
}

function stopPolling() {
    shouldPoll = false;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

function handleMqttDisconnect(reason) {
    if (!mqttConnected) {
        return;
    }
    mqttConnected = false;
    log(`MQTT ${reason}, stopping polls`);
    publishAvailability(false);
    stopPolling();
}

