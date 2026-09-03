# VerdantOS

This is the monorepo for VerdantOS, a capstone project developing an autonomous vertical farming system.   

---

## Repo Structure

```
verdant-os/
├── web/          # Web app — deployed via Vercel
├── firmware/
│   ├── arduino/  # Arduino sketches
│   └── esp32/    # ESP32 code
├── services/     # Raspberry Pi services
├── docs/         # Architecture diagrams, wiring guides, notes, etc
├── scripts/      # Shared build, deploy, or flash helper scripts
└── README.md
```

**Vercel** only sees the `web/` directory — the rest of the repo is ignored by it.  
**Arduino IDE / ESP-IDF** point at their respective subdirectory in `firmware/`.  
**Pi services** each live in their own folder under `services/` with their own requirements or package file.

---

## Branching & Merging

The golden rule: **never commit directly to `main`.** Always work on a branch, then merge via PR.

### Starting work

```bash
git checkout main
git pull                        # make sure you're up to date
git checkout -b feature-name
```

### Doing your work

```bash
git add .
git commit -m "short description of what you did"
git push -u origin feature-name
```

### Merging back to main

Open a pull request on GitHub — don't merge locally unless the team has agreed that's okay for a specific case.

Once the PR is merged on GitHub:

```bash
git checkout main
git pull                     # pull the merged changes down
git branch -d feature-name   # delete your local branch
```

### If main moved while you were working

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease # if you pushed before the rebase
```

---

## Branch Naming

Use `short-description` — e.g. `esp32-wifi-fix` or `pi-api-auth`.
