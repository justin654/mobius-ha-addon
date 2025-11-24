# Mobius Entities Home Assistant Add-on

This add-on logs into the EcoTech Mobius cloud API, decodes your Radion light and Vortech pump data, and publishes the values as MQTT sensors so Home Assistant can track them like any other entity.

## Features
- Uses your Mobius email/password (stored in add-on options) to grab `config.json` directly from the Mobius cloud.
- Decodes Radion channel intensities with the same logic used in the web dashboard.
- Publishes MQTT auto-discovery config for each channel plus the pump speed/mode, so Home Assistant creates entities automatically.
- Surfaces availability so you can automate alerts if the Mobius session drops.

## Configuration highlights
- `base_url` lets you point at alternate Mobius endpoints (e.g. beta cloud) if your account uses a different hostname.
- `debug_logging` (default `false`) prints the exact login payload and response for troubleshooting; only enable this temporarily since it logs your password in plain text.