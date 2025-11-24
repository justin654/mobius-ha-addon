# Mobius Entities (Home Assistant Add-on)

Bridge EcoTech Mobius data into Home Assistant without running the full web dashboard. The add-on logs into Mobius cloud, pulls the same `config.json` the app uses, decodes Radion/Vortech data, and publishes MQTT discovery payloads so sensors appear automatically.

## What you get
- **Radion coverage** – Every light found in your Mobius account exposes the full set of LED channel percentages plus an availability sensor. Entities follow the pattern `sensor.mobius_radion_<device>_<channel>`.
- **Vortech coverage** – Each pump reports the current speed percentage and whether it’s in Feed or Run mode.
- **Multi-device aware** – Works with any number of lights/pumps; entities are namespaced by serial/address so there are no MQTT collisions.
- **Robust polling** – Handles Mobius session drops with exponential backoff and flips sensors to “unavailable” if the API or MQTT broker goes offline.

## Requirements
1. **MQTT Broker**  
   Install the Mosquitto add-on (or any MQTT broker) and keep it running. The add-on uses Supervisor-provided credentials via `services.mqtt`.

2. **Mobius credentials**  
   Use the same email/password you log into the Mobius app with. They are stored only in add-on options and passed directly to Mobius.

## Installation
1. Add this repository to Home Assistant → Settings → Add-ons → Add-on Store → ⋮ → *Repositories*.
2. Install **Mobius Entities**.
3. Fill out the options form (see below) and click **Save**.
4. Start the add-on and check the logs for `Login successful` followed by `MQTT Connected`.

## Configuration options
| Option | Description |
| --- | --- |
| `email` / `password` | Mobius login. Required. |
| `base_url` | Leave as `https://cloud.mobius.app` unless your account uses a different hostname. |
| `poll_interval` | Seconds between successful polls (default 60). The add-on automatically backs off on failures. |
| `mqtt_topic_prefix` | Base MQTT discovery prefix. Default `homeassistant`. |
| `debug_logging` | When `true`, prints raw API payloads/responses. Use only when troubleshooting; it will log credentials. |

## Entities & topics
- Radion sensors publish discovery & state under `homeassistant/sensor/mobius_radion/<device>/<channel>/`.
- Vortech sensors use `homeassistant/sensor/mobius_vortech/<device>/<sensor>/`.
- Availability topic: `<prefix>/mobius/status`.

You can rename entities in HA as needed; IDs stay stable thanks to the device serial/address.

## Troubleshooting tips
- **Invalid username/password** – Confirm the add-on and the official Mobius app both work with the same credentials; if the app forces a password change, update the add-on.
- **No MQTT entities** – Verify Mosquitto is running, the add-on log shows “MQTT Connected”, and discovery topics exist (`mqtt explorer` or HA’s MQTT integration can help).
- **Debugging API issues** – Temporarily set `debug_logging: true` to capture the exact curl command/response. Remember to toggle it back off afterwards.