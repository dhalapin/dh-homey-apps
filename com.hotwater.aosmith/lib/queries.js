'use strict';

// GraphQL documents copied verbatim from py_aosmith/queries.py (py-aosmith 1.0.18).
// The client compares queries by identity, so keep these as single shared constants.

const LOGIN_QUERY = 'query login($passcode: String) { login(passcode: $passcode) { user { tokens { accessToken idToken refreshToken } } } }';

const DEVICES_QUERY = `
query devices($forceUpdate: Boolean, $junctionIds: [String]) {
    devices(forceUpdate: $forceUpdate, junctionIds: $junctionIds) {
        brand
        model
        deviceType
        dsn
        junctionId
        name
        serial
        location
        data {
            __typename
            temperatureSetpoint
            temperatureSetpointPending
            temperatureSetpointPrevious
            temperatureSetpointMaximum
            modes {
                mode
                controls
            }
            isOnline
            ... on HeatPump {
                firmwareVersion
                hotWaterStatus
                mode
                modePending
            }
            ... on NextGenHeatPump {
                firmwareVersion
                hotWaterStatus
                mode
                modePending
            }
            ... on RE3Connected {
                firmwareVersion
                hotWaterStatus
                mode
                modePending
            }
            ... on RE3Premium {
                firmwareVersion
                hotWaterStatus
                mode
                modePending
                hotWaterPlusLevel
            }
        }
    }
}
`;

const DEVICES_BASIC_INFO_QUERY = `
query devices($forceUpdate: Boolean, $junctionIds: [String]) {
    devices(forceUpdate: $forceUpdate, junctionIds: $junctionIds) {
        brand
        model
        deviceType
        dsn
        junctionId
        name
        serial
    }
}
`;

const ENERGY_USE_DATA_QUERY = `
query getEnergyUseData($dsn: String!, $deviceType: DeviceType!) {
    getEnergyUseData(dsn: $dsn, deviceType: $deviceType) {
        average
        graphData {
            date
            kwh
        }
        lifetimeKwh
        startDate
    }
}
`;

const UPDATE_SETPOINT_MUTATION = 'mutation updateSetpoint($junctionId: String!, $value: Int!) { updateSetpoint(junctionId: $junctionId, value: $value) }';
const UPDATE_MODE_MUTATION = 'mutation updateMode($junctionId: String!, $mode: ModeInput!) { updateMode(junctionId: $junctionId, mode: $mode) }';

module.exports = {
  LOGIN_QUERY,
  DEVICES_QUERY,
  DEVICES_BASIC_INFO_QUERY,
  ENERGY_USE_DATA_QUERY,
  UPDATE_SETPOINT_MUTATION,
  UPDATE_MODE_MUTATION,
};
