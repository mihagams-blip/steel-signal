# Steel Signal

A 3D modern-warfare turn-based hex wargame in the spirit of Panzer Corps 2 — combined arms
plus a contemporary arsenal: FPV strike drones, loitering munitions, recon UAVs, electronic
warfare, and infrastructure you can destroy for strategic effect.

**Scenario:** *Signal on the Vovcha* — cross the river, take the town, and hold both bridge
exits before turn 16.

## Running it

It is a static site with no build step. Any web server works:

```bash
python3 -m http.server 8103
```

Then open `http://localhost:8103`.

Opening `index.html` directly from the filesystem will **not** work — the game uses ES
modules, which browsers refuse to load over `file://`. It has to be served over HTTP.

## Stack

Plain browser ES modules. Three.js r170 from a CDN via the importmap in `index.html` — no
npm, no bundler, no install step. Everything except the 13 unit portraits is generated at
runtime: terrain, buildings, vehicles, textures, and all audio are procedural.

## Controls

| | |
|---|---|
| Click | select a unit |
| M | move · T attack · R fire mission |
| F | FPV strike · L loitering munition · X dig in |
| Tab | cycle units · G toggle grid |
| Enter | end turn · Esc cancel |

## Layout

```
index.html     importmap + HUD roots
js/core/       renderer, camera rig, post chain, procedural texture library
js/world/      terrain, hex math, settlements, infrastructure
js/units/      unit stats and procedural vehicle models
js/game/       state, combat resolution, fog of war, AI
js/fx/         explosions, drone camera, unit markers
js/ui/         HUD
js/audio/      WebAudio synthesis
art/units/     unit portraits (the only image assets)
data/          scenario definition
```
