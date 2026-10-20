'use strict';

const Homey = require('homey');
const { AOSmithClient, AOSmithInvalidCredentialsError } = require('../../lib/AOSmithClient');

module.exports = class WaterHeaterDriver extends Homey.Driver {

  async onInit() {
    this._clients = new Map();
  }

  /** One shared client per account, so multiple heaters share logins and polls. */
  getClient(email, password) {
    const key = email.toLowerCase();
    const existing = this._clients.get(key);
    if (existing && existing.hasCredentials(email, password)) return existing;
    const client = new AOSmithClient({ email, password });
    this._clients.set(key, client);
    return client;
  }

  async onPair(session) {
    let creds = null;
    let devices = [];

    session.setHandler('login', async (data) => {
      // Phone keyboards often add a trailing space to the email
      const email = String((data && data.username) || '').trim();
      const password = data && data.password;
      if (!email || !password) return false;

      try {
        devices = await this.getClient(email, password).getDevices();
      } catch (err) {
        // Don't keep a client around that holds rejected credentials
        this._clients.delete(email.toLowerCase());
        if (err instanceof AOSmithInvalidCredentialsError) return false;
        this.error('Login failed:', err.message);
        throw new Error('Could not reach the A. O. Smith cloud. Please try again in a moment.');
      }

      if (!devices.length) {
        throw new Error('No compatible A. O. Smith water heaters were found on this account.');
      }

      creds = { email, password };
      return true;
    });

    session.setHandler('list_devices', async () => devices.map((d) => ({
      name: d.name,
      data: { id: d.junctionId },
      store: { email: creds.email, password: creds.password },
    })));

    // Drop the credentials from memory when the pairing session ends
    session.setHandler('disconnect', async () => {
      creds = null;
      devices = [];
    });
  }

};
