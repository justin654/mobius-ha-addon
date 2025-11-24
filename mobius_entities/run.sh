#!/usr/bin/with-contenv bashio
set -euo pipefail

EMAIL=$(bashio::config 'email')
PASSWORD=$(bashio::config 'password')
POLL_INTERVAL=$(bashio::config 'poll_interval')
TOPIC_PREFIX=$(bashio::config 'mqtt_topic_prefix')
BASE_URL=$(bashio::config 'base_url')
DEBUG_LOGGING=$(bashio::config 'debug_logging')

if ! bashio::services.available 'mqtt'; then
    bashio::log.fatal 'MQTT service is not available. Please install and configure the Mosquitto broker add-on.'
    exit 1
fi

export MQTT_HOST=$(bashio::services 'mqtt' 'host')
export MQTT_PORT=$(bashio::services 'mqtt' 'port')
export MQTT_USERNAME=$(bashio::services 'mqtt' 'username')
export MQTT_PASSWORD=$(bashio::services 'mqtt' 'password')
export MOBIUS_EMAIL="$EMAIL"
export MOBIUS_PASSWORD="$PASSWORD"
export MOBIUS_POLL_INTERVAL="$POLL_INTERVAL"
export MQTT_TOPIC_PREFIX="$TOPIC_PREFIX"
export MOBIUS_BASE_URL="$BASE_URL"
export MOBIUS_DEBUG="$DEBUG_LOGGING"

bashio::log.info 'Starting Mobius entity bridge (Node.js)'
exec node /usr/src/app/index.js
