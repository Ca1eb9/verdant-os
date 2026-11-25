# VerdantOS

The monorepo for VerdantOS, a capstone project building an autonomous vertical
farm. Robots (ESP32-S3) carry plants between water, light and charging
stations, finding their way by RFID tags. A Raspberry Pi runs the farm: its
Node.js services talk to the robots over MQTT, and a Next.js dashboard shows
the farm on the farm's own WiFi (FarmNet) and remotely through Supabase.

---

## Repo structure

```
verdant-os/
├── farm-controller/   # Pi services (orchestrator, simulator, shelf bridge, …) and shared types
├── firmware/
│   ├── esp32/         # Robot firmware (PlatformIO, FreeRTOS)
│   └── shelf-sensor/  # Shelf sensor node (Arduino Uno R3, PlatformIO)
├── web/               # Dashboard (Next.js PWA), deployed to Vercel and served by the Pi
├── deploy/            # systemd units and env file examples for the Pi
├── scripts/           # Pi deploy, settings sync and FarmNet helper scripts
├── docs/              # Architecture, setup guides, wiring and the team timeline
└── AGENTS.md          # Rules for working in this repo (people and AI agents)
```

- **Vercel** only builds `web/`; it ignores the rest of the repo.
- **PlatformIO** opens each firmware folder (`firmware/esp32/`, `firmware/shelf-sensor/`) as its own project.
- **Pi services** are npm workspaces under `farm-controller/`, one folder each, all built on `@farm/shared`.

## Where to start

Read [AGENTS.md](AGENTS.md) first, whatever you work on: it lists the sources
of truth and the rules that keep the parts in step. Then:

| You're working on | Read |
|---|---|
| Pi services | [farm-controller/README.md](farm-controller/README.md), then the [orchestrator state machine](farm-controller/orchestrator/docs/state-machine.md) |
| Robot firmware | [docs/firmware-architecture.md](docs/firmware-architecture.md) (the robot–Pi contract), then [firmware/esp32/README.md](firmware/esp32/README.md) |
| Shelf sensors and grow lights | [docs/shelf-sensors.md](docs/shelf-sensors.md), then [firmware/shelf-sensor/README.md](firmware/shelf-sensor/README.md) |
| Dashboard | [web/README.md](web/README.md), then [web/docs/architecture.md](web/docs/architecture.md) |
| Setting up a Pi | [docs/WIFI-SETUP.md](docs/WIFI-SETUP.md), then [docs/PI-SERVICES.md](docs/PI-SERVICES.md) |
| Wiring | [docs/wiring/README.md](docs/wiring/README.md) |

Every doc is listed in [docs/README.md](docs/README.md).

---

## Branching and merging

**Never commit directly to `main`.** Work on a branch and merge through a pull request.

### Start a branch

```bash
git checkout main
git pull
git checkout -b short-description
```

Name it `short-description`, e.g. `esp32-wifi-fix` or `pi-api-auth`.

### Commit and push

```bash
git add <files>
git commit -m "Short imperative message"
git push -u origin short-description
```

Then open a pull request on GitHub. Don't merge locally unless the team has
agreed to it for that case. [AGENTS.md](AGENTS.md#before-you-open-a-pr) lists
what to check before you open one.

### If `main` moved while you were working

Rebase rather than merge, so the branch has no merge commits:

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease   # only if you pushed before the rebase
```

### After the PR is merged

```bash
git checkout main
git pull
git branch -d short-description
```

## License

Personal, non-commercial use only, with credit: see [LICENSE](LICENSE). Commercial and academic use need written permission.

## Credits

This project builds on the original [VerdantOS](https://github.com/TigerShock4982/VerdantOS) by its original contributors.
