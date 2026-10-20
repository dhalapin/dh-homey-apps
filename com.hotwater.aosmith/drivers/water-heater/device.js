'use strict';

const Homey = require('homey');
const { AOSmithInvalidCredentialsError } = require('../../lib/AOSmithClient');

// Intervals from the HA integration's const.py
const REGULAR_INTERVAL = 30 * 1000;
const FAST_INTERVAL = 1000; // while a mode/setpoint change is pending
const ENERGY_INTERVAL = 10 * 60 * 1000;
const AUTH_FAILED_INTERVAL = 5 * 60 * 1000; // back off so we don't lock the account

const MODE_TO_CAP = {
  HYBRID: 'eco', HEAT_PUMP: 'heat_pump', ELECTRIC: 'electric', VACATION: 'vacation', GUEST: 'guest',
};
const CAP_TO_MODE = Object.fromEntries(Object.entries(MODE_TO_CAP).map(([k, v]) => [v, k]));
const HWP_TO_LEVEL = { off: 0, level1: 1, level2: 2, level3: 3 };
const LEVEL_TO_HWP = Object.fromEntries(Object.entries(HWP_TO_LEVEL).map(([k, v]) => [v, k]));

const MIN_TEMP_F = 95; // _attr_min_temp in water_heater.py
const fToC = (f) => Math.round(((f - 32) * 5 / 9) * 10) / 10;
const cToF = (c) => Math.round(c * 9 / 5 + 32);

module.exports = class WaterHeaterDevice extends Homey.Device {

  async onInit() {
    const { email, password } = this.getStore();
    this._junctionId = this.getData().id;
    this._client = this.driver.getClient(email, password);
    this._last = null;
    this._optionsMaxF = null;
    this._modesConfigured = false;
    this._hwpListener = false;

    this.registerCapabilityListener('target_temperature', (c) => this._setTemperature(c));
    this.registerCapabilityListener('aosmith_mode', (m) => this._setMode(m));

    await this._pollStatus();
    this._pollEnergy();
  }

  // ---- polling --------------------------------------------------------------

  _schedule(ms) {
    if (this._deleted) return;
    if (this._statusTimer) this.homey.clearTimeout(this._statusTimer);
    this._statusTimer = this.homey.setTimeout(() => this._pollStatus(), ms);
  }

  async _pollStatus() {
    let next = REGULAR_INTERVAL;
    try {
      const devices = await this._client.getDevices();
      const device = devices.find((d) => d.junctionId === this._junctionId);
      if (!device) {
        await this.setUnavailable('Water heater not found on this account');
      } else {
        this._last = device;
        await this._apply(device);
        if (device.status.modeChangePending || device.status.temperatureSetpointPending) {
          next = FAST_INTERVAL;
        }
      }
    } catch (err) {
      this.error(err);
      if (err instanceof AOSmithInvalidCredentialsError) {
        next = AUTH_FAILED_INTERVAL;
        await this.setUnavailable('Login failed. Remove and re-add the device with your current password.').catch(this.error);
      } else {
        await this.setUnavailable('Cannot reach the A. O. Smith cloud').catch(this.error);
      }
    } finally {
      this._schedule(next);
    }
  }

  async _pollEnergy() {
    try {
      const { lifetimeKwh } = await this._client.getEnergyUseData(this._junctionId);
      await this.setCapabilityValue('meter_power', lifetimeKwh);
    } catch (err) {
      this.error('Energy poll failed', err);
    } finally {
      if (!this._deleted) {
        this._energyTimer = this.homey.setTimeout(() => this._pollEnergy(), ENERGY_INTERVAL);
      }
    }
  }

  async _apply(d) {
    const s = d.status;

    // Offline devices are unavailable, like AOSmithStatusEntity.available
    if (!s.isOnline) {
      await this.setUnavailable('Water heater is offline');
      return;
    }
    await this.setAvailable();

    // Max setpoint comes from the device and can change
    const maxF = s.temperatureSetpointMaximum;
    if (maxF && maxF !== this._optionsMaxF) {
      await this.setCapabilityOptions('target_temperature', { min: fToC(MIN_TEMP_F), max: fToC(maxF), step: 0.5 });
      this._optionsMaxF = maxF;
    }

    // Offer only the modes this model supports
    if (!this._modesConfigured) {
      const all = {
        eco: 'Eco (Hybrid)', heat_pump: 'Heat pump', electric: 'Electric', vacation: 'Vacation / away', guest: 'Guest',
      };
      const values = d.supportedModes
        .map((m) => MODE_TO_CAP[m.mode])
        .filter(Boolean)
        .map((id) => ({ id, title: { en: all[id] } }));
      if (values.length) await this.setCapabilityOptions('aosmith_mode', { values });
      this._modesConfigured = true;
    }

    // Hot Water+ select is only created for devices that support it
    if (d.supportsHotWaterPlus && !this.hasCapability('aosmith_hot_water_plus')) {
      await this.addCapability('aosmith_hot_water_plus');
    }
    if (this.hasCapability('aosmith_hot_water_plus') && !this._hwpListener) {
      this.registerCapabilityListener('aosmith_hot_water_plus', (v) => this._setHotWaterPlus(v));
      this._hwpListener = true;
    }

    await this.setCapabilityValue('target_temperature', fToC(s.temperatureSetpoint));
    const modeCap = MODE_TO_CAP[s.currentMode];
    if (modeCap) await this.setCapabilityValue('aosmith_mode', modeCap);
    if (s.hotWaterStatus != null) await this.setCapabilityValue('measure_hot_water', s.hotWaterStatus);
    if (this.hasCapability('aosmith_hot_water_plus') && s.hotWaterPlusLevel != null) {
      await this.setCapabilityValue('aosmith_hot_water_plus', LEVEL_TO_HWP[s.hotWaterPlusLevel] || 'off');
    }
  }

  // ---- commands -------------------------------------------------------------

  async _setTemperature(celsius) {
    const f = cToF(celsius);
    const max = this._last && this._last.status.temperatureSetpointMaximum;
    if (max && f > max) {
      throw new Error(`Maximum is ${max}°F. Raise the limit on the water heater itself first.`);
    }
    await this._client.updateSetpoint(this._junctionId, f);
    this._schedule(FAST_INTERVAL);
  }

  async _setMode(capValue) {
    const mode = CAP_TO_MODE[capValue];
    const supported = this._last && this._last.supportedModes.some((m) => m.mode === mode);
    if (!mode || !supported) throw new Error('Mode not supported by this water heater');
    await this._client.updateMode(this._junctionId, mode);
    this._schedule(FAST_INTERVAL);
  }

  async _setHotWaterPlus(value) {
    // Mirrors select.py: re-send the current mode with the new Hot Water+ level
    await this._client.updateMode(this._junctionId, this._last.status.currentMode, {
      hotWaterPlusLevel: HWP_TO_LEVEL[value],
    });
    this._schedule(FAST_INTERVAL);
  }

  // ---- lifecycle ------------------------------------------------------------

  async onDeleted() { this._stop(); }

  async onUninit() { this._stop(); }

  _stop() {
    this._deleted = true;
    if (this._statusTimer) this.homey.clearTimeout(this._statusTimer);
    if (this._energyTimer) this.homey.clearTimeout(this._energyTimer);
  }

};
