# beautiful-mermaid examples

Complex Mermaid (and swimlane) samples used as renderer test data.
Every `*.mmd` file under this tree must `renderMermaidSVG` to a well-formed SVG
(`src/__tests__/examples.test.ts`). Interactive SVG demos at the root
(`*-interactive.svg`) are not part of that inventory.

## Flowchart

| File | Pattern |
| --- | --- |
| `flowchart/ota-firmware-state-machine.mmd` | Nested subgraphs, DFU branches, mixed shapes |
| `flowchart/ble-connection-topology.mmd` | Central / air / two peripherals, notify edges |
| `flowchart/ci-release-pipeline.mmd` | Parallel CI jobs, release gate |

## Sequence

| File | Pattern |
| --- | --- |
| `sequence/ble-gatt-ota.mmd` | `autonumber`, loop, nested alt, Note over |
| `sequence/mqtt-command-ack.mmd` | 3-way alt, opt + inner loop |
| `sequence/rest-provisioning.mmd` | `par` / `and`, 409/404 alt |

## State

| File | Pattern |
| --- | --- |
| `state/dfu-session.mmd` | Composite `Streaming { }` plus fail/abort |
| `state/power-modes.mmd` | Sleep / radio, nested `Run { }` |

## Class / ER / XY

| File | Pattern |
| --- | --- |
| `class/firmware-hal.mmd` | Interface, abstract sensor, bus aggregation |
| `class/interface-model.mmd` | Spec composition, MQTT/BLE bindings |
| `er/device-fleet.mmd` | Tenant / device / firmware / audit |
| `er/ble-att-cache.mmd` | GATT DB, CCCD subscriptions |
| `xychart/rssi-over-time.mmd` | Mixed line + bar, negative dBm axis |
| `xychart/heap-watermark.mmd` | DFU heap line |

## Swimlane

Dedicated `lane` DSL and `swimlane-beta` subgraph form. Root
`swimlane-basic.mmd` / `swimlane-firmware.mmd` stay as smaller fixtures.

| File | Pattern |
| --- | --- |
| `swimlane/ble-connect-notify.mmd` | 3 lanes, diamond, stadium, cross-lane |
| `swimlane/usb-control-enum.mmd` | TB enumeration then vendor IN |
| `swimlane/can-isotp-dtc.mmd` | ISO-TP SF/FF/FC/CF |
| `swimlane/mqtt-ota-chunk.mmd` | `swimlane-beta` subgraphs, HMAC diamond |
| `swimlane/i2c-sensor-burst.mmd` | Clock stretch, CRC retry loop |
