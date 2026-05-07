"use strict";
/**
 * BK215 wire protocol — constants, t-codes, message codes, limits.
 *
 * Reverse-engineered from the MIT-licensed Python reference implementation
 * (Sonnenladen GmbH, https://github.com/SonnenladenGmbH/sunenergyxt-api)
 * and verified against device behaviour at runtime.
 *
 * Protocol summary:
 *   - Transport:   TCP/IP, port 8000 (default)
 *   - Encoding:    ASCII
 *   - Framing:     line-based; messages terminated by "\r\n" (best-effort: lone "\n"
 *                  is also accepted to be tolerant of firmware quirks)
 *   - Body:        JSON object { "code": <int>, "data": <object> }
 *   - Discovery:   mDNS/Bonjour, service type "_http._tcp.local.", id "hp-bk215"
 *
 * After TCP connect, the device only starts sending status reports once the
 * client emits a single handshake message:
 *   {"code":24658,"data":{}}\r\n
 *
 * The device replies once with an empty ACK ({"code":0,"data":{}}) and then
 * begins streaming periodic status reports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MDNS_TXT_KEY_ID = exports.MDNS_TXT_KEY_MODEL = exports.MDNS_TXT_KEY_FW = exports.MDNS_DEVICE_IDENTIFIER = exports.MDNS_SERVICE_TYPE = exports.Limits = exports.Field = exports.VALUE_UNAVAILABLE = exports.ACK_SUCCESS = exports.MessageCode = exports.RECONNECT_MAX_DELAY_MS = exports.RECONNECT_INITIAL_DELAY_MS = exports.DEFAULT_IDLE_TIMEOUT_MS = exports.DEFAULT_RESPONSE_TIMEOUT_MS = exports.DEFAULT_CONNECT_TIMEOUT_MS = exports.DEFAULT_PORT = void 0;
exports.isAvailable = isAvailable;
exports.assertInRange = assertInRange;
// ---------------------------------------------------------------------------
// Transport defaults
// ---------------------------------------------------------------------------
exports.DEFAULT_PORT = 8000;
/** Time to wait for the initial TCP handshake to complete. */
exports.DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
/** Time to wait for an ACK after sending a command. */
exports.DEFAULT_RESPONSE_TIMEOUT_MS = 2_000;
/** Time without any inbound data before the watchdog forces a reconnect. */
exports.DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** Initial backoff between reconnect attempts. */
exports.RECONNECT_INITIAL_DELAY_MS = 1_000;
/** Hard cap on the reconnect backoff (also after long outages). */
exports.RECONNECT_MAX_DELAY_MS = 60_000;
// ---------------------------------------------------------------------------
// Message codes (top-level "code" field of the JSON envelope)
// ---------------------------------------------------------------------------
var MessageCode;
(function (MessageCode) {
    /** Sent by client to request a value change. */
    MessageCode[MessageCode["CommandSet"] = 24662] = "CommandSet";
    /** Sent by device in reply to CommandSet. */
    MessageCode[MessageCode["ResponseAck"] = 24663] = "ResponseAck";
    /** Periodic status report sent by device. */
    MessageCode[MessageCode["DataReport"] = 24658] = "DataReport";
    /** Alternate status report (firmware-version-dependent). */
    MessageCode[MessageCode["DataReportAlt"] = 24661] = "DataReportAlt";
})(MessageCode || (exports.MessageCode = MessageCode = {}));
// ---------------------------------------------------------------------------
// ACK semantics inside the "data" object of a ResponseAck
// ---------------------------------------------------------------------------
/** Per-field ACK code that means "command applied successfully". */
exports.ACK_SUCCESS = 0;
/**
 * Special sentinel returned by the device for fields that are not present
 * (e.g. expansion battery slots that are physically empty).
 * Treat as "value unavailable", *not* as a real reading.
 */
exports.VALUE_UNAVAILABLE = -1;
// ---------------------------------------------------------------------------
// Field identifiers ("t-codes")
//
// The device exposes parameters as numbered fields named "t<num>[_<sub>]".
// Grouped here by semantic role for readability.
// ---------------------------------------------------------------------------
exports.Field = {
    // --- Mode switches (boolean: 0 = off, 1 = on) ---
    /** Local-mode master switch. Must be ON for any local command to take effect. */
    LocalMode: "t598",
    /** Battery charging mode (the device actively pulls grid power into the battery). */
    BatteryChargingMode: "t700_1",
    /** Car/EV charging mode. */
    CarChargingMode: "t701_1",
    /** Home appliance mode = the zero-feed-in operating mode. */
    HomeApplianceMode: "t702_1",
    /** AC active mode (mixed power). */
    AcActiveMode: "t728",
    // --- SoC limits (percent) ---
    /** Global discharge floor. Range 1..20 %. */
    SystemDischargeLimit: "t362",
    /** Global charge ceiling. Range 70..100 %. */
    SystemChargeLimit: "t363",
    /** Cutoff SoC for home appliance mode. Range 5..20 %. */
    HomeDischargeCutoff: "t720",
    /** Cutoff SoC for car charging mode. Range 5..40 %. */
    CarDischargeCutoff: "t721",
    /** Cutoff SoC for battery charging mode. Range 80..100 %. */
    BatteryChargeCutoff: "t727",
    // --- Power and timeouts ---
    /** Charging / output power setpoint in watts. Range 0..3600. */
    SystemChargingPower: "t590",
    /** Idle auto-shutdown timeout in minutes. Range 15..1440. */
    IdleShutdownTime: "t596",
    /** Low-battery auto-shutdown timeout in minutes. Range 5..1440. */
    LowBatteryShutdownTime: "t597",
    // --- Read-only sensors: SoC ---
    /** Overall pack SoC (%). Use this as the primary battery indicator. */
    OverallSoc: "t211",
    /** SoC of the head storage module. */
    HeadStorage: "t592",
    Expansion1: "t593",
    Expansion2: "t594",
    Expansion3: "t595",
    Expansion4: "t1001",
    Expansion5: "t1002",
    Expansion6: "t1003",
    Expansion7: "t1004",
    // --- Read-only sensors: BMS hardware limits (percent) ---
    HeadHwDischargeLimit: "t507",
    HeadHwChargeLimit: "t508",
    Expansion1HwDischarge: "t509",
    Expansion1HwCharge: "t510",
    Expansion2HwDischarge: "t511",
    Expansion2HwCharge: "t512",
    Expansion3HwDischarge: "t513",
    Expansion3HwCharge: "t514",
    Expansion4HwDischarge: "t948",
    Expansion4HwCharge: "t949",
    Expansion5HwDischarge: "t950",
    Expansion5HwCharge: "t951",
    Expansion6HwDischarge: "t952",
    Expansion6HwCharge: "t953",
    Expansion7HwDischarge: "t954",
    Expansion7HwCharge: "t955",
};
// ---------------------------------------------------------------------------
// Value range constraints (mirror the device's BMS rules)
// ---------------------------------------------------------------------------
exports.Limits = {
    SystemDischargeLimit: { min: 1, max: 20 },
    SystemChargeLimit: { min: 70, max: 100 },
    HomeDischargeCutoff: { min: 5, max: 20 },
    CarDischargeCutoff: { min: 5, max: 40 },
    BatteryChargeCutoff: { min: 80, max: 100 },
    SystemChargingPower: { min: 0, max: 3600 },
    IdleShutdownTime: { min: 15, max: 1440 },
    LowBatteryShutdownTime: { min: 5, max: 1440 },
};
// ---------------------------------------------------------------------------
// mDNS discovery
// ---------------------------------------------------------------------------
/** Bonjour service type advertised by the BK215. */
exports.MDNS_SERVICE_TYPE = "http";
/** TXT-record / hostname token that identifies a BK215 specifically. */
exports.MDNS_DEVICE_IDENTIFIER = "hp-bk215";
exports.MDNS_TXT_KEY_FW = "fw_ver";
exports.MDNS_TXT_KEY_MODEL = "model";
exports.MDNS_TXT_KEY_ID = "id";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Returns true if the value reported by the device is a real reading
 * (i.e. not the {@link VALUE_UNAVAILABLE} sentinel and not null/undefined).
 *
 * @param value
 */
function isAvailable(value) {
    return typeof value === "number" && value !== exports.VALUE_UNAVAILABLE;
}
/**
 * Asserts that `value` lies within `[min, max]`. Throws a `RangeError` if not.
 * Use before sending a SET command.
 *
 * @param value
 * @param range
 * @param range.min
 * @param range.max
 * @param fieldName
 */
function assertInRange(value, range, fieldName) {
    if (!Number.isFinite(value) || value < range.min || value > range.max) {
        throw new RangeError(`${fieldName} must be in [${range.min}, ${range.max}], got ${value}`);
    }
}
