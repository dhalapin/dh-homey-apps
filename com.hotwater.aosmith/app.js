'use strict';

const Homey = require('homey');

module.exports = class AOSmithApp extends Homey.App {

  async onInit() {
    this.log('A. O. Smith app started');
  }

};
