# A. O. Smith for Homey (unofficial)

Monitor and control A. O. Smith iCOMM water heaters from Homey.
A port of the Home Assistant `aosmith` integration and its `py-aosmith` 1.0.18 client.
Not affiliated with A. O. Smith; the cloud API is unofficial and may change without notice.

## Features
- Target temperature, operating mode (eco, heat pump, electric, vacation, guest where supported)
- Hot Water+ level (supported models), hot water availability, lifetime energy use

## Layout
- `lib/AOSmithClient.js`: cloud client (port of `py_aosmith/client.py`)
- `lib/queries.js`: GraphQL documents, identical to `py_aosmith/queries.py`
- `drivers/water-heater/`: pairing, polling and capabilities

## Development
`homey app run` (the manifest must declare `"runtime": "nodejs"`).

## Credentials
The cloud has no token-only login, so the app keeps your iCOMM email and password in the
device's private store on your Homey (not in settings, and never logged or shown in the UI).
They are only sent to A. O. Smith over HTTPS. If you change your password, remove and re-add the device.

## Notes
- The API uses Fahrenheit. The app converts to Celsius for Homey and back, rounded to whole degrees F.
- The cloud is polled every 30 s, or every 1 s while a change is pending.
- Failed requests are retried 3 times, 5 s apart.
