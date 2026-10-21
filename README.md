# Homey Apps

A collection of community-built apps for [Homey](https://homey.app), maintained by [Daniel Halapin](https://github.com/danielhalapin).

> [!WARNING]
> **These apps are provided "as is", without warranty of any kind, and may break at any time without warning.**
>
> Most of them talk to third-party cloud services through **unofficial, undocumented APIs**. The companies behind those services can change or shut down their APIs whenever they like, and when they do, the apps here may stop working until someone updates them. There is no guarantee that anyone will.
>
> Use them at your own risk. Don't rely on them for anything safety-critical, and always keep a way to control your devices without them.

## Apps

| App | App ID | What it does | Status |
|---|---|---|---|
| [A. O. Smith (iCOMM)](#a-o-smith-icomm) | `com.hotwater.aosmith` | Monitor and control A. O. Smith iCOMM water heaters | Working, unofficial |

More apps may be added over time. Each app lives in its own folder, named after its app ID.

---

## A. O. Smith (iCOMM)

Monitor and control A. O. Smith water heaters that use the iCOMM cloud service, using the same account you use in the A. O. Smith mobile app.

This is a port of the [Home Assistant `aosmith` integration](https://www.home-assistant.io/integrations/aosmith) and of the [`py-aosmith`](https://github.com/bdr99/py-aosmith) library it uses.

### Features

- **Target temperature**, limited to the maximum your heater allows
- **Operating mode:** eco (hybrid), heat pump, electric, vacation and guest, offering only the modes your model supports
- **Hot Water+ level** (off, 1–3) on models that support it
- **Hot water availability** as a percentage, shown as a read-only bar and logged in Homey Insights
- **Lifetime energy use** in kWh, refreshed every 10 minutes
- **Offline detection:** the device shows as unavailable when the heater is offline or the cloud can't be reached

### Supported devices

The app works with the device types supported by `py-aosmith`: `HeatPump`, `NextGenHeatPump`, `RE3Connected` and `RE3Premium`. Other A. O. Smith devices on your account are ignored.

It was developed and tested on a **Homey Self-Hosted Server**. Other Homey platforms haven't been tested.

### Requirements

- Homey firmware **13.0.0 or newer**, on a platform that runs apps locally (Homey Pro or Homey Self-Hosted Server)
- An A. O. Smith / iCOMM account **with a password**. Accounts created through "Sign in with Apple/Google" may not have one.
- Your water heater set up in the A. O. Smith mobile app and online

### How it works

The app polls the iCOMM cloud. It does not talk to the heater directly, so it needs an internet connection and the cloud service to be up.

- Status is polled every **30 seconds**, or every **1 second** while a mode or temperature change is pending.
- Failed requests are retried 3 times, 5 seconds apart.
- The cloud API works in °F. The app converts to °C for Homey and rounds to whole °F when sending a setpoint to the heater.
- Hot water availability is a percentage. Some models only report coarse levels, which the app maps to approximate values.
- Selecting **vacation** mode uses the maximum duration the API allows (100 days).

### Credentials and privacy

The iCOMM service has no token-only login, so the app has to keep your **email address and password** in order to sign in again when its session expires.

- They are stored in the device's private store on your Homey. They are not shown in settings or the UI, and the app never logs them.
- They are only sent to the A. O. Smith cloud over HTTPS.
- If you change your iCOMM password, remove the device and add it again.
- Anyone with access to your Homey's storage could read them, so protect your Homey accordingly.

### Known limitations

- The API is unofficial. A change on A. O. Smith's side can break the app without notice. If login suddenly starts failing for no reason, the client's app-version header may need updating.
- If a login fails repeatedly, the app backs off to one attempt every 5 minutes to avoid locking your account.
- Features of newer or unlisted heater models may be missing.

---

## Installing an app from this repository

Apps in this repository are installed from source with the Homey CLI. They are not (yet) in the Homey App Store.

**You will need:** [Node.js](https://nodejs.org), [Docker](https://www.docker.com) (the CLI uses it to run apps on your Homey) and the Homey CLI.

```bash
npm install --global homey
homey login          # sign in to your Homey account (not needed for a Self-Hosted Server)
homey select         # choose which Homey to install to

git clone https://github.com/<your-username>/<repository>.git
cd <repository>/com.hotwater.aosmith
```

Then either:

```bash
homey app run        # run the app while the terminal stays open (development mode)
homey app install    # install the app permanently
```

When the app is running, add your device in Homey under **Devices → Add Device → A. O. Smith**. See the [Homey CLI documentation](https://apps.developer.homey.app/the-basics/getting-started/homey-cli) for details.

## Repository layout

```
.
├── README.md                  this file
└── com.hotwater.aosmith/      one folder per app, named after the app ID
    ├── app.js
    ├── lib/                   cloud client code
    ├── drivers/               pairing, polling and capabilities
    └── .homeycompose/         app manifest and custom capabilities
```

Run all Homey CLI commands from inside an app's folder, not from the repository root.

## Reporting problems

Bug reports and pull requests are welcome, but because these are spare-time projects I can't promise a response or a fix.

If you open an issue, please include:

- your Homey model and firmware version
- the app version
- what you expected to happen and what happened instead
- relevant log output from `homey app run`

> [!CAUTION]
> **Never paste your password, access tokens or full device details (serial numbers, DSN) into an issue.** Remove them from any logs first.

## Disclaimer

- These apps are **not affiliated with, endorsed by or supported by** A. O. Smith, Athom (the makers of Homey), Home Assistant or any other company named here.
- A. O. Smith, iCOMM, Homey and any other product names are trademarks of their respective owners and are used only to describe compatibility.
- Everything is provided **"as is"**, with no warranty, no guarantee of availability and no obligation to maintain it. The authors are not liable for any damage, data loss, account lockouts, energy costs or other problems that result from using them.

## Credits

- [**py-aosmith**](https://github.com/bdr99/py-aosmith) by Brandon Rothweiler (MIT license): the A. O. Smith cloud client that the app's `lib/` code is ported from
- The [**Home Assistant `aosmith` integration**](https://www.home-assistant.io/integrations/aosmith), whose entity model, modes and polling behaviour this app follows
- The [**Homey Apps SDK**](https://apps.developer.homey.app) by Athom

## License

Released under the **GNU General Public License v3.0**. See [`LICENSE`](com.hotwater.aosmith/LICENSE) for the full text.
