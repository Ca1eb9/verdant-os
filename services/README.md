# services

Services that run on the Raspberry Pi, one folder per service.

Each subfolder is independently deployable — its own dependencies, entry point, and config. Services communicate with each other and the web app via whatever protocol is documented in `docs/`.

**Structure:**
```
services/
└── service-name/
    ├── main.py          (or index.js etc.)
    ├── requirements.txt (or package.json)
    └── README.md
```
