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
    will: {
        topic: `${MQTT_TOPIC_PREFIX}/mobius/status`,
        payload: 'offline',
        retain: true
    }
});

mqttClient.on('connect', () => {
    log('MQTT Connected');
    mqttClient.publish(`${MQTT_TOPIC_PREFIX}/mobius/status`, 'online', { retain: true });
    publishDiscovery();
    startPolling();
});

mqttClient.on('error', (err) => {
    error('MQTT Error:', err);
});

function publishDiscovery() {
    RADION_SENSORS.forEach(sensor => {
        const topic = `${MQTT_TOPIC_PREFIX}/sensor/mobius_radion_${sensor.key}/config`;
        const payload = {
            name: `Mobius ${sensor.name}`,
            unique_id: `mobius_radion_${sensor.key}`,
            state_topic: `${MQTT_TOPIC_PREFIX}/sensor/mobius_radion_${sensor.key}/state`,
            availability_topic: `${MQTT_TOPIC_PREFIX}/mobius/status`,
            unit_of_measurement: sensor.unit,
            device: {
                identifiers: ['mobius_radion'],
                name: 'Mobius Radion',
                manufacturer: 'EcoTech Marine'
            }
        };
        mqttClient.publish(topic, JSON.stringify(payload), { retain: true });
    });

    VORTECH_SENSORS.forEach(sensor => {
        const topic = `${MQTT_TOPIC_PREFIX}/sensor/mobius_${sensor.key}/config`;
        const payload = {
            name: `Mobius ${sensor.name}`,
            unique_id: `mobius_${sensor.key}`,
            state_topic: `${MQTT_TOPIC_PREFIX}/sensor/mobius_${sensor.key}/state`,
            availability_topic: `${MQTT_TOPIC_PREFIX}/mobius/status`,
            unit_of_measurement: sensor.unit,
            device: {
                identifiers: ['mobius_vortech'],
                name: 'Mobius Vortech',
                manufacturer: 'EcoTech Marine'
            }
        };
        mqttClient.publish(topic, JSON.stringify(payload), { retain: true });
    });
}

function findDevice(config, modelId) {
    if (!config.tanks) return null;
    for (const tank of config.tanks) {
        if (!tank.devices) continue;
        for (const device of tank.devices) {
            if (device.model === modelId) return device;
        }
    }
    return null;
}

async function processConfig(config) {
    const radion = findDevice(config, 179);
    const vortech = findDevice(config, 147);

    if (radion) {
        const schedule = radion.schedule || {};
        const points = schedule.points || [];
        let idx = schedule.lastIndexUsed || 0;
        idx = Math.max(0, Math.min(idx, points.length - 1));
        
        if (points.length > 0) {
            const channels = decodeRadionPoint(points[idx].data);
            RADION_SENSORS.forEach(sensor => {
                const entry = channels[sensor.channel];
                const val = entry ? entry.percent : null;
                const topic = `${MQTT_TOPIC_PREFIX}/sensor/mobius_radion_${sensor.key}/state`;
                mqttClient.publish(topic, val === null ? 'unavailable' : String(val));
            });
        }
    }

    if (vortech) {
        const schedule = vortech.schedule || {};
        const points = schedule.points || [];
        let speed = null;
        if (points.length > 0) {
            speed = decodePumpPoint(points[0].data);
        }
        const mode = (vortech.vectraInfo && vortech.vectraInfo.feedModeReturnDelay) ? 'Feed' : 'Run';

        mqttClient.publish(`${MQTT_TOPIC_PREFIX}/sensor/mobius_vortech_speed/state`, speed === null ? 'unavailable' : String(speed));
        mqttClient.publish(`${MQTT_TOPIC_PREFIX}/sensor/mobius_vortech_mode/state`, mode);
    }
}

async function poll() {
    try {
        const config = await fetchConfig();
        await processConfig(config);
        mqttClient.publish(`${MQTT_TOPIC_PREFIX}/mobius/status`, 'online', { retain: true });
    } catch (err) {
        error('Polling failed:', err);
        mqttClient.publish(`${MQTT_TOPIC_PREFIX}/mobius/status`, 'offline', { retain: true });
        authCookie = null; // Clear session on error to force re-login
    }
}

function startPolling() {
    poll(); // Initial
    setInterval(poll, POLL_INTERVAL * 1000);
}

