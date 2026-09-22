# Pi WiFi access point setup

The Pi runs its own isolated WiFi network (`FarmNet`) for farm devices. ESP32s and laptops connect over WiFi to reach the Pi's services (MQTT, dashboard). The farm network has no internet access by design — it's a closed loop. The Pi itself reaches the internet over Ethernet for the Supabase bridge, but it does not forward that connection to FarmNet devices.

## Network layout

```
Internet ← [Ethernet] ← Pi (192.168.4.1) → [WiFi AP: FarmNet] → ESP32s, laptops
                         ↑                   ↑
                   Supabase bridge only       No internet, farm traffic only
```

- `wlan0` — WiFi access point, `192.168.4.1`, runs DHCP/DNS for farm devices
- `eth0` — wired uplink, used only by the Pi itself (Supabase bridge)
- DHCP range: `192.168.4.10` – `192.168.4.50` (40 devices)
- DNS: only `farmnet` and `farmnet.local` resolve — no external domains

## Install

```bash
sudo apt install hostapd dnsmasq
sudo systemctl stop hostapd dnsmasq
```

## Configure

### 1. Static IP for the WiFi interface

Add to the end of `/etc/dhcpcd.conf`:

```
interface wlan0
    static ip_address=192.168.4.1/24
    nohook wpa_supplicant
```

### 2. Access point — `/etc/hostapd/hostapd.conf`

```
interface=wlan0
driver=nl80211
ssid=FarmNet
hw_mode=g
channel=7
wmm_enabled=0
auth_algs=1
wpa=2
wpa_passphrase=CHANGE-THIS-PASSWORD
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
```

Then point the system service at this file. In `/etc/default/hostapd`, set:

```
DAEMON_CONF="/etc/hostapd/hostapd.conf"
```

### 3. DHCP + DNS — `/etc/dnsmasq.conf`

```
interface=wlan0
dhcp-range=192.168.4.10,192.168.4.50,255.255.255.0,24h
dhcp-option=6,192.168.4.1
address=/farmnet/192.168.4.1
address=/farmnet.local/192.168.4.1
```

No `server=` line — dnsmasq only resolves `farmnet` and `farmnet.local`. External domains don't resolve for FarmNet devices, which is intentional. The Pi itself still resolves external domains through its Ethernet connection's DNS.

### 4. Explicitly block forwarding

IP forwarding should be off (the default), but confirm it:

```bash
# Should return 0
cat /proc/sys/net/ipv4/ip_forward
```

If it returns `1`, disable it:

```bash
echo "net.ipv4.ip_forward=0" | sudo tee -a /etc/sysctl.conf
sudo sysctl -w net.ipv4.ip_forward=0
```

Do **not** add any iptables NAT or MASQUERADE rules. No traffic should route from `wlan0` to `eth0`.

## Enable and reboot

```bash
sudo systemctl unmask hostapd
sudo systemctl enable hostapd dnsmasq
sudo reboot
```

## Verify

After reboot:

1. `FarmNet` should appear as a WiFi network
2. Connect a laptop, confirm it gets a `192.168.4.x` IP
3. `ping 192.168.4.1` — Pi responds
4. `http://farmnet:3000` — dashboard loads (once deployed)
5. `ping google.com` — should fail (no internet on FarmNet, this is correct)
6. On the Pi itself via SSH over Ethernet: `ping google.com` — should work

## ESP32 firmware connection

```c
#define WIFI_SSID     "FarmNet"
#define WIFI_PASS     "CHANGE-THIS-PASSWORD"
#define MQTT_BROKER   "192.168.4.1"
#define MQTT_PORT     1883
```

Use the IP, not `farmnet`, for the MQTT broker in firmware. DNS adds a failure point for no benefit on microcontrollers.

## Mosquitto WebSocket config

To allow the dashboard's browser-based MQTT connection, add `/etc/mosquitto/conf.d/websockets.conf`:

```
listener 1883
listener 9001
protocol websockets
```

Restart with `sudo systemctl restart mosquitto`.

## Notes

- **Change the password** in both `hostapd.conf` and the firmware before Showcase.
- **Channel 7** is a reasonable default. If interference is an issue, try 1 or 11.
- `hw_mode=g` is 2.4GHz, which is what ESP32s support. Don't use `a` (5GHz).
- If the Pi has no Ethernet connected, the farm still works — local MQTT, local dashboard, everything except Supabase sync.
- Laptops connected to FarmNet won't have internet. Developers who need both can use Ethernet for internet and connect to FarmNet over WiFi, or switch networks as needed.
- The Supabase bridge running on the Pi uses `eth0` for its outbound WebSocket connection. It is the only service that touches the internet.
