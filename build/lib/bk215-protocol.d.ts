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
export declare const DEFAULT_PORT = 8000;
/** Time to wait for the initial TCP handshake to complete. */
export declare const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/** Time to wait for an ACK after sending a command. */
export declare const DEFAULT_RESPONSE_TIMEOUT_MS = 2000;
/** Time without any inbound data before the watchdog forces a reconnect. */
export declare const DEFAULT_IDLE_TIMEOUT_MS = 60000;
/** Initial backoff between reconnect attempts. */
export declare const RECONNECT_INITIAL_DELAY_MS = 1000;
/** Hard cap on the reconnect backoff (also after long outages). */
export declare const RECONNECT_MAX_DELAY_MS = 60000;
export declare enum MessageCode {
    /** Sent by client to request a value change. */
    CommandSet = 24662,// 24662
    /** Sent by device in reply to CommandSet. */
    ResponseAck = 24663,// 24663
    /** Periodic status report sent by device. */
    DataReport = 24658,// 24658
    /** Alternate status report (firmware-version-dependent). */
    DataReportAlt = 24661
}
/** Per-field ACK code that means "command applied successfully". */
export declare const ACK_SUCCESS = 0;
/**
 * Special sentinel returned by the device for fields that are not present
 * (e.g. expansion battery slots that are physically empty).
 * Treat as "value unavailable", *not* as a real reading.
 */
export declare const VALUE_UNAVAILABLE = -1;
export declare const Field: {
    /** Local-mode master switch. Must be ON for any local command to take effect. */
    readonly LocalMode: "t598";
    /** Battery charging mode (the device actively pulls grid power into the battery). */
    readonly BatteryChargingMode: "t700_1";
    /** Car/EV charging mode. */
    readonly CarChargingMode: "t701_1";
    /** Home appliance mode = the zero-feed-in operating mode. */
    readonly HomeApplianceMode: "t702_1";
    /** AC active mode (mixed power). */
    readonly AcActiveMode: "t728";
    /** Global discharge floor. Range 1..20 %. */
    readonly SystemDischargeLimit: "t362";
    /** Global charge ceiling. Range 70..100 %. */
    readonly SystemChargeLimit: "t363";
    /** Cutoff SoC for home appliance mode. Range 5..20 %. */
    readonly HomeDischargeCutoff: "t720";
    /** Cutoff SoC for car charging mode. Range 5..40 %. */
    readonly CarDischargeCutoff: "t721";
    /** Cutoff SoC for battery charging mode. Range 80..100 %. */
    readonly BatteryChargeCutoff: "t727";
    /** Charging / output power setpoint in watts. Range 0..3600. */
    readonly SystemChargingPower: "t590";
    /** Idle auto-shutdown timeout in minutes. Range 15..1440. */
    readonly IdleShutdownTime: "t596";
    /** Low-battery auto-shutdown timeout in minutes. Range 5..1440. */
    readonly LowBatteryShutdownTime: "t597";
    /** Overall pack SoC (%). Use this as the primary battery indicator. */
    readonly OverallSoc: "t211";
    /** SoC of the head storage module. */
    readonly HeadStorage: "t592";
    readonly Expansion1: "t593";
    readonly Expansion2: "t594";
    readonly Expansion3: "t595";
    readonly Expansion4: "t1001";
    readonly Expansion5: "t1002";
    readonly Expansion6: "t1003";
    readonly Expansion7: "t1004";
    readonly HeadHwDischargeLimit: "t507";
    readonly HeadHwChargeLimit: "t508";
    readonly Expansion1HwDischarge: "t509";
    readonly Expansion1HwCharge: "t510";
    readonly Expansion2HwDischarge: "t511";
    readonly Expansion2HwCharge: "t512";
    readonly Expansion3HwDischarge: "t513";
    readonly Expansion3HwCharge: "t514";
    readonly Expansion4HwDischarge: "t948";
    readonly Expansion4HwCharge: "t949";
    readonly Expansion5HwDischarge: "t950";
    readonly Expansion5HwCharge: "t951";
    readonly Expansion6HwDischarge: "t952";
    readonly Expansion6HwCharge: "t953";
    readonly Expansion7HwDischarge: "t954";
    readonly Expansion7HwCharge: "t955";
};
/** Type-safe set of all known field names (the values of the `Field` table). */
export type FieldName = (typeof Field)[keyof typeof Field];
export declare const Limits: {
    readonly SystemDischargeLimit: {
        readonly min: 1;
        readonly max: 20;
    };
    readonly SystemChargeLimit: {
        readonly min: 70;
        readonly max: 100;
    };
    readonly HomeDischargeCutoff: {
        readonly min: 5;
        readonly max: 20;
    };
    readonly CarDischargeCutoff: {
        readonly min: 5;
        readonly max: 40;
    };
    readonly BatteryChargeCutoff: {
        readonly min: 80;
        readonly max: 100;
    };
    readonly SystemChargingPower: {
        readonly min: 0;
        readonly max: 3600;
    };
    readonly IdleShutdownTime: {
        readonly min: 15;
        readonly max: 1440;
    };
    readonly LowBatteryShutdownTime: {
        readonly min: 5;
        readonly max: 1440;
    };
};
/**
 * Wire-level message envelope.
 * Every message — inbound or outbound — has exactly these two top-level keys.
 */
export interface BK215Envelope<TData = Record<string, unknown>> {
    code: number;
    data: TData;
}
export type CommandPayload = Partial<Record<FieldName, number>>;
export type AckPayload = Partial<Record<FieldName, number>>;
export type StatusPayload = Partial<Record<string, number>>;
/** Bonjour service type advertised by the BK215. */
export declare const MDNS_SERVICE_TYPE = "http";
/** TXT-record / hostname token that identifies a BK215 specifically. */
export declare const MDNS_DEVICE_IDENTIFIER = "hp-bk215";
export declare const MDNS_TXT_KEY_FW = "fw_ver";
export declare const MDNS_TXT_KEY_MODEL = "model";
export declare const MDNS_TXT_KEY_ID = "id";
/**
 * Returns true if the value reported by the device is a real reading
 * (i.e. not the {@link VALUE_UNAVAILABLE} sentinel and not null/undefined).
 *
 * @param value
 */
export declare function isAvailable(value: number | null | undefined): value is number;
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
export declare function assertInRange(value: number, range: {
    min: number;
    max: number;
}, fieldName: string): void;
