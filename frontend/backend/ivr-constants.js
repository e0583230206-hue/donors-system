// ivr-constants.js
//
// Shared constants for the IVR flow. Exists specifically so ivr.js and
// modules ivr.js itself requires (e.g. ivr-number-compose.service.js) never
// need to require each other for a single constant — avoids a circular
// dependency once ivr.js starts requiring the number-compose service.

const MAX_PAYMENT_AMOUNT = 99999;

module.exports = { MAX_PAYMENT_AMOUNT };
