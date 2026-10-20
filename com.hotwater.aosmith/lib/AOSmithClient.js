'use strict';

/**
 * JavaScript port of py-aosmith 1.0.18 (https://github.com/bdr99/py-aosmith, py_aosmith/client.py).
 * Unofficial: this is not an official A. O. Smith API and may stop working without warning.
 * Requires Node 18+ (global fetch / AbortSignal.timeout), which Homey firmware 12+ provides.
 *
 * Temperatures are degrees Fahrenheit, exactly as the API returns them.
 */

const {
  LOGIN_QUERY,
  DEVICES_QUERY,
  DEVICES_BASIC_INFO_QUERY,
  ENERGY_USE_DATA_QUERY,
  UPDATE_SETPOINT_MUTATION,
  UPDATE_MODE_MUTATION,
} = require('./queries');

const API_BASE_URL = 'https://r2.wh8.co';
const APP_VERSION = '14.1.0';
const USER_AGENT = 'okhttp/4.12.0';
const TIMEOUT_MS = 20 * 1000;

// py-aosmith retries "unknown" failures 6x with a 10 s wait. That would freeze a Homey
// device for up to a minute, so this port uses a shorter schedule.
const RETRY_ATTEMPTS = 3;
const RETRY_WAIT_MS = 5 * 1000;

const MIN_SETPOINT_F = 95;
const COMPATIBLE_TYPES = ['HeatPump', 'NextGenHeatPump', 'RE3Connected', 'RE3Premium'];

class AOSmithInvalidCredentialsError extends Error {}
class AOSmithInvalidParametersError extends Error {}
class AOSmithEnergyUsageDataUnavailableError extends Error {}
class AOSmithUnknownError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- passcode (must match python's json.dumps + urllib.parse.quote + base64) ----

// json.dumps escapes non-ASCII as lowercase \uXXXX (ensure_ascii=True)
const pyJsonString = (s) => JSON.stringify(s).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// urllib.parse.quote keeps '/' and escapes !'()* (the opposite of encodeURIComponent)
const pyQuote = (s) => encodeURIComponent(s)
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  .replace(/%2F/g, '/');

function buildPasscode(email, password) {
  const json = `{"email": ${pyJsonString(email)}, "password": ${pyJsonString(password)}, "locale": "en"}`;
  return Buffer.from(pyQuote(json)).toString('base64');
}

// ---- response mapping ----

function mapModeStrToOperationMode(modeStr) {
  switch (modeStr) {
    case 'HYBRID': return 'HYBRID';
    case 'HEAT_PUMP':
    case 'EFFICIENCY': return 'HEAT_PUMP';
    case 'ELECTRIC':
    case 'STANDARD': return 'ELECTRIC';
    case 'VACATION': return 'VACATION';
    case 'GUEST': return 'GUEST';
    default: throw new AOSmithUnknownError('Unknown mode');
  }
}

function mapHotWaterPlusStatusToInt(s) {
  switch (s) {
    case 'OFF': return 0;
    case 'ONE': return 1;
    case 'TWO': return 2;
    case 'THREE': return 3;
    default: return null;
  }
}

function mapModeDict(modeDict) {
  const modeStr = modeDict.mode;
  if (modeStr == null) throw new AOSmithUnknownError('Failed to determine mode');

  let hasDaySelection = false;
  let supportsHotWaterPlus = false;
  const controls = modeDict.controls;
  if (controls === 'SELECT_DAYS') hasDaySelection = true;
  else if (controls === 'HOT_WATER_PLUS') supportsHotWaterPlus = true;
  else if (controls != null) throw new AOSmithUnknownError('Unknown controls');

  return {
    mode: mapModeStrToOperationMode(modeStr),
    originalName: modeStr,
    hasDaySelection,
    supportsHotWaterPlus,
  };
}

function parseHotWaterStatus(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    switch (value.toUpperCase()) {
      case 'LOW': return 33;
      case 'MEDIUM': return 66;
      case 'HIGH': return 100;
      default: break;
    }
  } else if (Number.isInteger(value)) {
    // The API value increases as hot water is used, so normalize it
    return 100 - value;
  }
  throw new AOSmithUnknownError('Unknown hot water status');
}

function mapDevice(d) {
  const typename = d.data && d.data.__typename;
  if (typename == null) throw new AOSmithUnknownError('Failed to determine device type');
  if (!COMPATIBLE_TYPES.includes(typename)) throw new AOSmithUnknownError('Unknown device type');

  const required = ['brand', 'model', 'dsn', 'junctionId', 'name', 'serial', 'location', 'data'];
  if (!required.every((k) => k in d)) throw new AOSmithUnknownError('Missing required keys');

  const requiredData = [
    'temperatureSetpoint', 'temperatureSetpointPending', 'temperatureSetpointPrevious',
    'temperatureSetpointMaximum', 'modes', 'isOnline', 'firmwareVersion', 'hotWaterStatus',
    'mode', 'modePending',
  ];
  if (!requiredData.every((k) => k in d.data)) throw new AOSmithUnknownError('Missing required data keys');

  return {
    brand: d.brand,
    model: d.model,
    deviceType: typename,
    dsn: d.dsn,
    junctionId: d.junctionId,
    name: d.name,
    serial: d.serial,
    installLocation: d.location,
    supportedModes: d.data.modes.map(mapModeDict),
    supportsHotWaterPlus: typename === 'RE3Premium',
    status: {
      firmwareVersion: d.data.firmwareVersion,
      isOnline: d.data.isOnline,
      currentMode: mapModeStrToOperationMode(d.data.mode),
      modeChangePending: d.data.modePending,
      temperatureSetpoint: d.data.temperatureSetpoint,
      temperatureSetpointPending: d.data.temperatureSetpointPending,
      temperatureSetpointPrevious: d.data.temperatureSetpointPrevious,
      temperatureSetpointMaximum: d.data.temperatureSetpointMaximum,
      hotWaterStatus: parseHotWaterStatus(d.data.hotWaterStatus),
      hotWaterPlusLevel: mapHotWaterPlusStatusToInt(d.data.hotWaterPlusLevel == null ? '' : d.data.hotWaterPlusLevel),
    },
  };
}

function mapEnergyUseData(e) {
  if (!('graphData' in e) || !('lifetimeKwh' in e)) throw new AOSmithUnknownError('Missing required keys');
  return {
    lifetimeKwh: e.lifetimeKwh,
    history: e.graphData.map((h) => {
      if (!('date' in h) || !('kwh' in h)) throw new AOSmithUnknownError('Missing required keys');
      return { date: h.date, energyUseKwh: h.kwh };
    }),
  };
}

// ---- client ----

class AOSmithClient {

  // Credentials and the session token are private fields so they can never show up
  // in logs, JSON.stringify() or util.inspect() if a client object is printed by accident.
  #email;
  #password;
  #token = null;

  constructor({ email, password }) {
    this.#email = email;
    this.#password = password;
    this._loginPromise = null;
    this._inflight = null;
    this._cache = null; // { at, devices }
  }

  /** True if this client was created with these credentials (the password is never exposed). */
  hasCredentials(email, password) {
    return this.#email.toLowerCase() === String(email).toLowerCase() && this.#password === password;
  }

  /**
   * Compatible water heaters on the account. Concurrent and near-simultaneous calls
   * (several heaters on one account) share a single cloud request.
   */
  async getDevices() {
    if (this._cache && Date.now() - this._cache.at < 500) return this._cache.devices;
    if (this._inflight) return this._inflight;

    this._inflight = this._fetchDevices()
      .then((devices) => {
        this._cache = { at: Date.now(), devices };
        return devices;
      })
      .finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async updateSetpoint(junctionId, setpoint) {
    if (setpoint < MIN_SETPOINT_F) throw new AOSmithInvalidParametersError('Setpoint is below the minimum');

    const device = await this._getDeviceByJunctionId(junctionId);
    if (setpoint > device.status.temperatureSetpointMaximum) {
      throw new AOSmithInvalidParametersError('Setpoint is above the maximum');
    }

    const res = await this._send(UPDATE_SETPOINT_MUTATION, { junctionId, value: setpoint }, true);
    this._cache = null;
    if (!res.data || res.data.updateSetpoint !== true) throw new AOSmithUnknownError('Failed to update setpoint');
  }

  /**
   * @param {string} junctionId
   * @param {'HYBRID'|'HEAT_PUMP'|'ELECTRIC'|'VACATION'|'GUEST'} mode
   * @param {{days?: number, hotWaterPlusLevel?: number}} [opts]
   */
  async updateMode(junctionId, mode, { days = null, hotWaterPlusLevel = null } = {}) {
    const device = await this._getDeviceByJunctionId(junctionId);

    const desired = device.supportedModes.find((m) => m.mode === mode);
    if (!desired) throw new AOSmithInvalidParametersError('Mode not supported by this device');

    let daysToSend = days;
    if (desired.hasDaySelection) {
      if (daysToSend == null) daysToSend = 100;
      else if (daysToSend <= 0 || daysToSend > 100) throw new AOSmithInvalidParametersError('Invalid days selection');
    } else if (daysToSend != null) {
      throw new AOSmithInvalidParametersError('Days not supported for this operation mode');
    }

    const payload = { mode: desired.originalName };
    if (desired.hasDaySelection) payload.days = daysToSend;

    if (device.supportsHotWaterPlus) {
      // Devices that support Hot Water+ always send hotWaterPlusLevel, even for modes that don't use it
      if (hotWaterPlusLevel == null) {
        if (desired.supportsHotWaterPlus) {
          payload.hotWaterPlusLevel = device.status.hotWaterPlusLevel == null ? 0 : device.status.hotWaterPlusLevel;
        } else {
          payload.hotWaterPlusLevel = 0;
        }
      } else {
        if (!Number.isInteger(hotWaterPlusLevel) || hotWaterPlusLevel < 0 || hotWaterPlusLevel > 3) {
          throw new AOSmithInvalidParametersError('Invalid Hot Water+ level');
        }
        if ([1, 2, 3].includes(hotWaterPlusLevel) && !desired.supportsHotWaterPlus) {
          throw new AOSmithInvalidParametersError('Hot Water+ not supported for this operation mode');
        }
        payload.hotWaterPlusLevel = hotWaterPlusLevel;
      }
    } else if (hotWaterPlusLevel != null) {
      throw new AOSmithInvalidParametersError('Hot Water+ not supported for this device');
    }

    const res = await this._send(UPDATE_MODE_MUTATION, { junctionId, mode: payload }, true);
    this._cache = null;
    if (!res.data || res.data.updateMode !== true) throw new AOSmithUnknownError('Failed to update mode');
  }

  /** @returns {Promise<{lifetimeKwh: number, history: Array<{date: string, energyUseKwh: number}>}>} */
  async getEnergyUseData(junctionId) {
    const res = await this._send(DEVICES_BASIC_INFO_QUERY, { forceUpdate: true }, true);
    const infos = res.data && res.data.devices;
    if (!infos) throw new AOSmithUnknownError('Failed to retrieve devices');

    infos.forEach((i) => {
      if (!['brand', 'model', 'deviceType', 'dsn', 'junctionId', 'name', 'serial'].every((k) => k in i)) {
        throw new AOSmithUnknownError('Missing required keys');
      }
    });
    const info = infos.find((i) => i.junctionId === junctionId);
    if (!info) throw new AOSmithUnknownError('Device not found');

    let energyRes;
    try {
      energyRes = await this._send(ENERGY_USE_DATA_QUERY, { dsn: info.dsn, deviceType: info.deviceType }, true);
    } catch (err) {
      if (err instanceof AOSmithEnergyUsageDataUnavailableError) return { lifetimeKwh: 0, history: [] };
      throw err;
    }
    const data = energyRes.data && energyRes.data.getEnergyUseData;
    if (data == null) throw new AOSmithUnknownError('Failed to retrieve energy use data');
    return mapEnergyUseData(data);
  }

  // ---- internals ----

  async _fetchDevices() {
    const res = await this._send(DEVICES_QUERY, { forceUpdate: true }, true);
    const devices = res.data && res.data.devices;
    if (devices == null) throw new AOSmithUnknownError('Failed to retrieve devices');

    return devices
      .filter((d) => d.data && d.data.__typename != null && COMPATIBLE_TYPES.includes(d.data.__typename))
      .map(mapDevice);
  }

  async _getDeviceByJunctionId(junctionId) {
    const devices = await this._fetchDevices(); // always fresh, like py-aosmith
    const device = devices.find((d) => d.junctionId === junctionId);
    if (!device) throw new AOSmithUnknownError('Device not found');
    return device;
  }

  async _login() {
    if (this._loginPromise) return this._loginPromise; // one login at a time
    this._loginPromise = (async () => {
      const res = await this._send(LOGIN_QUERY, { passcode: buildPasscode(this.#email, this.#password) }, false);
      const tokens = res.data && res.data.login && res.data.login.user && res.data.login.user.tokens;
      this.#token = (tokens && tokens.accessToken) || null;
    })().finally(() => { this._loginPromise = null; });
    return this._loginPromise;
  }

  /** Sends a query, retrying only "unknown" failures (like py-aosmith's tenacity decorator). */
  async _send(query, variables, loginRequired) {
    let lastErr;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        return await this._sendOnce(query, variables, loginRequired, false);
      } catch (err) {
        if (!(err instanceof AOSmithUnknownError)) throw err;
        lastErr = err;
        if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_WAIT_MS);
      }
    }
    throw lastErr;
  }

  async _sendOnce(query, variables, loginRequired, retryingAfterLogin) {
    const headers = {
      'Content-Type': 'application/json',
      brand: 'icomm',
      version: APP_VERSION,
      'User-Agent': USER_AGENT,
    };

    if (loginRequired) {
      if (this.#token == null) {
        await this._login();
        if (this.#token == null) throw new AOSmithUnknownError('Login failed');
      }
      headers.authorization = `Bearer ${this.#token}`;
    }

    let response;
    try {
      response = await fetch(`${API_BASE_URL}/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err && err.name === 'TimeoutError') throw new AOSmithUnknownError('Request timed out');
      throw new AOSmithUnknownError('Request failed');
    }

    if (response.status === 401) {
      if (!loginRequired || retryingAfterLogin) throw new AOSmithUnknownError('Received status code 401 after logging in');
      this.#token = null; // access token may be expired: log in again once
      await this._login();
      return this._sendOnce(query, variables, loginRequired, true);
    }
    if (response.status !== 200) throw new AOSmithUnknownError(`Received status code ${response.status}`);

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new AOSmithUnknownError('Invalid response');
    }

    if (Array.isArray(json.errors)) {
      const errors = json.errors;
      if (errors.some((e) => e && e.extensions && e.extensions.code === 'INVALID_CREDENTIALS')) {
        throw new AOSmithInvalidCredentialsError('Invalid email address or password');
      }
      if (query === ENERGY_USE_DATA_QUERY && errors.some((e) => e && e.message === 'No data to display at this time.')) {
        throw new AOSmithEnergyUsageDataUnavailableError('Energy usage data is unavailable');
      }
      throw new AOSmithUnknownError(`Error: ${errors.map((e) => (e && e.message) || '').join(', ')}`);
    }

    if (query === DEVICES_QUERY) {
      const devices = (json.data && json.data.devices) || [];
      if (devices.some((d) => !d.data || d.data.isOnline == null)) {
        throw new AOSmithUnknownError('Device data is incomplete');
      }
    }

    return json;
  }

}

module.exports = {
  AOSmithClient,
  AOSmithInvalidCredentialsError,
  AOSmithInvalidParametersError,
  AOSmithUnknownError,
  buildPasscode,
};
