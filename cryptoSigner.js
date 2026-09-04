const crypto = require('crypto');

// Master secret key used to cryptographically sign licenses.
// Embedded verification key in Android client validates this signature.
const MASTER_SIGNING_KEY = process.env.JEEP_CARD_SIGNING_KEY || "JEEP_CARD_SECURE_HMAC_KEY_2026_@v3.6.2#KAREEM";

/**
 * Builds canonical string representation of a license.
 */
function buildCanonicalPayload(license) {
    return [
        `LIC:${license.id || ''}`,
        `DEV:${license.deviceId || ''}`,
        `APP:${license.appId || ''}`,
        `PLAN:${license.plan || ''}`,
        `START:${license.startAt || 0}`,
        `EXP:${license.expiresAt || 0}`
    ].join('|');
}

/**
 * Generates an HMAC-SHA256 signature for a license.
 */
function signLicense(license) {
    const canonical = buildCanonicalPayload(license);
    const hmac = crypto.createHmac('sha256', MASTER_SIGNING_KEY);
    hmac.update(canonical);
    return hmac.digest('hex');
}

/**
 * Verifies that a license signature matches the payload.
 */
function verifyLicense(license) {
    if (!license || !license.signature) return false;
    const expected = signLicense(license);
    return crypto.timingSafeEqual(
        Buffer.from(license.signature, 'hex'),
        Buffer.from(expected, 'hex')
    );
}

/**
 * Generates a human-friendly pairing code like K7P9-X4QM.
 */
function generatePairingCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Exclude 0, 1, I, O to prevent confusion
    let part1 = '';
    let part2 = '';
    for (let i = 0; i < 4; i++) {
        part1 += chars.charAt(Math.floor(Math.random() * chars.length));
        part2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${part1}-${part2}`;
}

module.exports = {
    MASTER_SIGNING_KEY,
    buildCanonicalPayload,
    signLicense,
    verifyLicense,
    generatePairingCode
};
