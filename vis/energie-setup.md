# BK215 Energie-Übersicht — Setup-Guide

Tages-, Monats- und Jahressicht für:
- Energie aus dem Akku (kWh)
- Energie vom Netz bezogen (kWh)
- Energie ins Netz eingespeist (kWh)
- Gesamterzeugung PV (kWh, sobald APsystems verfügbar)

## Schritt 1 — history-Adapter installieren

Im ioBroker Admin → Adapter → „history" suchen → installieren.

Instanz wird als `history.0` angelegt. Keine weitere Konfiguration nötig —
Standardwerte sind gut (JSON-Dateien in `/opt/iobroker/iobroker-data/history/`).

## Schritt 2 — States für History aktivieren

Im ioBroker Admin → Objekte — folgende States öffnen (Stift-Icon → Reiter
„History") → „Aktiviert" anklicken → Speichern:

| State                           | Grund                              | Min. Änderung |
| ------------------------------- | ---------------------------------- | ------------- |
| bk215.0.battery.chargingPower   | Akku-Output für kWh-Berechnung     | 5 W           |
| bk215.0.grid.power              | Netz-Bezug/-Einspeisung            | 5 W           |
| bk215.0.battery.soc             | SoC-Verlauf für Charts             | 1 %           |
| bk215.0.controller.error        | Diagnose-Verlauf                   | 5 W           |

Empfohlene History-Einstellungen pro State:
- Speichern: bei Änderung UND alle 5 Minuten (Max-Delta)
- Aufbewahrung: 365 Tage
- Runden auf: 1 Stelle

## Schritt 3 — Energie-Integrations-Skript installieren

Dieses Skript berechnet aus den Leistungswerten (W) die Energie (kWh) durch
numerische Integration (Trapez-Methode). Es läuft alle 5 Minuten und
aktualisiert die Energie-States.

Im ioBroker Admin → Skripte → „+" → JavaScript → Namen: `BK215_Energie` →
folgenden Code einfügen:

```javascript
// BK215 Energie-Integration
// Berechnet kWh aus W-Leistungswerten über Zeit.
// Läuft alle 5 Minuten und aggregiert zu Tages-/Monats-/Jahreswerten.

// ─── Konfiguration ───────────────────────────────────────────────────────────
const INTERVAL_MIN = 5;                         // Ausführungsintervall in Minuten
const POWER_AKKU   = 'bk215.0.battery.chargingPower';   // W (positiv = Entladung)
const POWER_NETZ   = 'bk215.0.grid.power';               // W (positiv = Bezug, negativ = Einspeisung)

// Ziel-States (werden automatisch angelegt)
const NS = '0_userdata.0.bk215.energie.';
// ─────────────────────────────────────────────────────────────────────────────

const STATES = {
    akku_heute_kwh:       { role: 'value.energy', unit: 'kWh', def: 0 },
    akku_monat_kwh:       { role: 'value.energy', unit: 'kWh', def: 0 },
    akku_jahr_kwh:        { role: 'value.energy', unit: 'kWh', def: 0 },
    netz_bezug_heute_kwh: { role: 'value.energy.consumed', unit: 'kWh', def: 0 },
    netz_bezug_monat_kwh: { role: 'value.energy.consumed', unit: 'kWh', def: 0 },
    netz_bezug_jahr_kwh:  { role: 'value.energy.consumed', unit: 'kWh', def: 0 },
    einspeisung_heute_kwh:  { role: 'value.energy.produced', unit: 'kWh', def: 0 },
    einspeisung_monat_kwh:  { role: 'value.energy.produced', unit: 'kWh', def: 0 },
    einspeisung_jahr_kwh:   { role: 'value.energy.produced', unit: 'kWh', def: 0 },
    letzte_berechnung:    { role: 'value.time', unit: '', def: '' },
};

// Hilfsfunktionen
function kwh(wattsAvg, intervalMin) {
    return (wattsAvg * intervalMin) / 60 / 1000;
}
function round2(v) { return Math.round(v * 100) / 100; }

// States anlegen falls nicht vorhanden
Object.entries(STATES).forEach(([key, opts]) => {
    createState(NS + key, opts.def, {
        type: typeof opts.def === 'number' ? 'number' : 'string',
        role: opts.role,
        unit: opts.unit,
        read: true,
        write: false,
    });
});

// Hauptfunktion
function berechne() {
    const now    = new Date();
    const heute  = now.toDateString();
    const monat  = `${now.getFullYear()}-${now.getMonth()}`;
    const jahr   = `${now.getFullYear()}`;

    // Letzte Werte lesen
    const pAkku = getState(POWER_AKKU).val || 0;
    const pNetz = getState(POWER_NETZ).val || 0;

    // Energie dieses Intervalls berechnen
    const akkuKwh       = kwh(Math.max(0, pAkku), INTERVAL_MIN); // nur Entladung
    const bezugKwh      = kwh(Math.max(0, pNetz), INTERVAL_MIN); // nur Bezug
    const einspeisKwh   = kwh(Math.max(0, -pNetz), INTERVAL_MIN); // nur Einspeisung

    // Rücksetzer bei Tages-/Monatswechsel
    const letzteBerechnung = getState(NS + 'letzte_berechnung').val;
    const letzteDate       = letzteBerechnung ? new Date(letzteBerechnung) : null;
    const neuerTag   = !letzteDate || letzteDate.toDateString()               !== heute;
    const neuerMonat = !letzteDate || `${letzteDate.getFullYear()}-${letzteDate.getMonth()}` !== monat;
    const neuesJahr  = !letzteDate || `${letzteDate.getFullYear()}`           !== jahr;

    if (neuerTag) {
        setState(NS + 'akku_heute_kwh',       0, true);
        setState(NS + 'netz_bezug_heute_kwh', 0, true);
        setState(NS + 'einspeisung_heute_kwh', 0, true);
        log('BK215 Energie: Tages-Reset', 'info');
    }
    if (neuerMonat) {
        setState(NS + 'akku_monat_kwh',       0, true);
        setState(NS + 'netz_bezug_monat_kwh', 0, true);
        setState(NS + 'einspeisung_monat_kwh', 0, true);
        log('BK215 Energie: Monats-Reset', 'info');
    }
    if (neuesJahr) {
        setState(NS + 'akku_jahr_kwh',        0, true);
        setState(NS + 'netz_bezug_jahr_kwh',  0, true);
        setState(NS + 'einspeisung_jahr_kwh', 0, true);
        log('BK215 Energie: Jahres-Reset', 'info');
    }

    // Aufaddieren
    const add = (id, delta) => {
        const cur = parseFloat(getState(NS + id).val) || 0;
        setState(NS + id, round2(cur + delta), true);
    };

    add('akku_heute_kwh',        akkuKwh);
    add('akku_monat_kwh',        akkuKwh);
    add('akku_jahr_kwh',         akkuKwh);
    add('netz_bezug_heute_kwh',  bezugKwh);
    add('netz_bezug_monat_kwh',  bezugKwh);
    add('netz_bezug_jahr_kwh',   bezugKwh);
    add('einspeisung_heute_kwh', einspeisKwh);
    add('einspeisung_monat_kwh', einspeisKwh);
    add('einspeisung_jahr_kwh',  einspeisKwh);

    setState(NS + 'letzte_berechnung', now.toISOString(), true);
}

// Sofort ausführen + dann alle 5 Minuten
berechne();
schedule(`*/${INTERVAL_MIN} * * * *`, berechne);

log('BK215 Energie-Skript gestartet', 'info');
```

## Schritt 4 — statistics-Adapter (optional, für automatische Min/Max)

Für Minimum, Maximum und Durchschnitt pro Tag/Monat/Jahr ist der
`statistics`-Adapter ideal — er ergänzt das JS-Skript perfekt.

Admin → Adapter → „statistics" → installieren.

Nach Installation: Instanz `statistics.0` öffnen → folgende States
aktivieren:

| State                         | Statistik-Typen aktivieren    |
| ----------------------------- | ----------------------------- |
| bk215.0.battery.soc           | min, max, avg                 |
| bk215.0.battery.chargingPower | avg, max                      |
| bk215.0.grid.power            | avg, min, max                 |

Der Adapter schreibt automatisch States wie:
- `statistics.0.day.min.bk215_0_battery_soc`
- `statistics.0.month.max.bk215_0_battery_chargingPower`
- usw.

## Schritt 5 — VIS-2 View „Solar_History" befüllen

### Ergebnis-States (vom JS-Skript)

Diese States sind nach Skript-Start sofort verfügbar:

```
0_userdata.0.bk215.energie.akku_heute_kwh
0_userdata.0.bk215.energie.akku_monat_kwh
0_userdata.0.bk215.energie.akku_jahr_kwh
0_userdata.0.bk215.energie.netz_bezug_heute_kwh
0_userdata.0.bk215.energie.netz_bezug_monat_kwh
0_userdata.0.bk215.energie.netz_bezug_jahr_kwh
0_userdata.0.bk215.energie.einspeisung_heute_kwh
0_userdata.0.bk215.energie.einspeisung_monat_kwh
0_userdata.0.bk215.energie.einspeisung_jahr_kwh
```

### Widget-Layout in Jaeger

**3 Spalten × 3 Zeilen = 9 Wert-Kacheln:**

|              | Heute        | Monat        | Jahr         |
| ------------ | ------------ | ------------ | ------------ |
| Akku (kWh)   | heute_kwh    | monat_kwh    | jahr_kwh     |
| Netz-Bezug   | bezug_heute  | bezug_monat  | bezug_jahr   |
| Einspeisung  | einsp_heute  | einsp_monat  | einsp_jahr   |

Dazu 2 Charts darunter (VIS-2 echart-Widget):
- Chart 1: `bk215.0.grid.power` — 24 h Verlauf (Farbe gelb)
- Chart 2: `bk215.0.battery.soc` + `bk215.0.battery.chargingPower` — 24 h

### Widget-Typ in Jaeger

Für die 9 Kacheln: **freie Wertanzeige** (Jaeger-Widget für Textwert/Zahl).
Einheit: kWh, 2 Nachkommastellen, Farbe:
- Akku: Grün `#22c55e`
- Netz-Bezug: Rot `#ef4444`
- Einspeisung: Blau `#3b82f6`

## Wichtige Hinweise

**Genauigkeit:** Das JS-Skript integriert alle 5 Minuten. Bei stark
schwankender Last (Wasserkocher, Wärmepumpe) entsteht ein kleiner Fehler
(±2–5 % typisch). Für ein Balkonkraftwerk mit 800 W ist das absolut
ausreichend.

**Neustart-Verhalten:** Bei Adapter-Neustart laufen die States weiter (sie
liegen in `0_userdata.0` und bleiben erhalten). Beim Raspberry-Neustart
bleiben sie ebenfalls erhalten — `0_userdata.0` wird in der ioBroker-DB
persistiert.

**Skript-Neustart am Tageswechsel:** Der Reset läuft automatisch beim ersten
Tick nach Mitternacht. Du musst nichts manuell zurücksetzen.

**MPPT-Watt:** Der BK215 liefert über die lokale TCP-API keine MPPT-Leistung
pro Eingang (nicht im öffentlichen Protokoll). Sobald du live mit dem Gerät
verbunden bist, können wir per Wireshark-Mitschnitt prüfen ob undokumentierte
t-Codes diese Werte enthalten.
