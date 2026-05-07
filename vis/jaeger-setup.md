# BK215 im Jaeger Design Adapter — Setup-Guide

Schritt-für-Schritt-Anleitung für deine konkrete Konstellation:

- **Speicher:** Sunlit / SunEnergyXT BK215, lokal über `iobroker.bk215` angebunden
- **Inverter:** APsystems 800 VA (DC-seitig hinter dem BK215)
- **Netzzähler:** Shelly Pro 3EM, über `iobroker.shelly` angebunden
- **Frontend:** ioBroker.vis-2 mit Jaeger Design Adapter (lizenziert)

> **Kalibrierungs-Hinweis:** Die exakten Slot-Bezeichnungen und Konfigurations-Pfade in Jaeger ändern sich zwischen Versionen. Wo unten ein konkreter Slot genannt ist, basiert das auf der offiziellen Jaeger-Doku und den Tutorial-Videos. Bei Abweichungen in deiner Installation: die Logik bleibt gleich, der Pfad heißt eventuell leicht anders. Prüfungen vor Ort sind in den Schritten markiert.

## Setup-Reihenfolge

```text
1. History-Adapter aktivieren  (5 min)
2. Statusleiste oben einrichten  (10 min)
3. Hauptmenü "Energie" konfigurieren  (15 min)
4. Eigene Seite "Regler" anlegen  (15 min)
5. Sicherheits-Verknüpfung mit dem Alarm-System  (10 min)
6. Optional: Theming-Feinschliff  (10 min)
```

---

## Schritt 1 — History-Adapter aktivieren

Damit die Verlaufsanzeigen in Jaeger funktionieren, müssen die wichtigsten BK215-States historisiert werden.

Im ioBroker-Admin → Objekte → die folgenden States öffnen, Reiter "History" → "Aktiviert":

| State                              | Aufzeichnungs-Intervall | Aufbewahrung |
| ---------------------------------- | ----------------------- | ------------ |
| `bk215.0.battery.soc`              | bei Änderung (≥ 1 %)    | 90 Tage      |
| `bk215.0.battery.chargingPower`    | bei Änderung (≥ 10 W)   | 30 Tage      |
| `bk215.0.grid.power`               | bei Änderung (≥ 10 W)   | 30 Tage      |
| `bk215.0.controller.error`         | bei Änderung (≥ 5 W)    | 7 Tage       |

Die Schwellen verhindern, dass die History-DB mit Mess-Rauschen überflutet wird. 1 % SoC ist die natürliche Quantisierung des BK215; 10 W passen zur Reglertoleranz.

---

## Schritt 2 — Statusleiste oben

Die Jaeger-Statusleiste (oben am Bildschirm) eignet sich für 4–5 Live-Werte, die du immer sehen willst. Empfehlung von links nach rechts:

| Position | Datenpunkt                            | Anzeige                              | Schwellenfarben                                |
| :------: | ------------------------------------- | ------------------------------------ | ---------------------------------------------- |
|    1     | `bk215.0.battery.soc`                 | "Akku 67 %"                          | <10 rot · <25 orange · <80 grün · ≥80 gelb     |
|    2     | `bk215.0.grid.power`                  | "Netz +120 W" / "Netz −340 W"        | >+10 rot · ±10 grün · <−10 blau                |
|    3     | `bk215.0.battery.chargingPower`       | "BK215 Output 250 W"                 | konstant blau                                  |
|    4     | `apsystems.0.energy.today` *(separater Adapter)* | "Ertrag heute 3,4 kWh" | konstant orange/akzent                          |

> **Reality-check:** Jaeger lässt typischerweise 4–6 Statusleisten-Positionen zu, die Konfiguration läuft über eine eigene Konfig-Seite des Jaeger-Adapters (kein VIS-Editor). Wenn dein Jaeger nur 3 Slots hat, lass Position 4 (Tagesertrag) weg — die siehst du auch im PV-Kreis auf der Übersicht.

> **APsystems-Hinweis:** Für Position 4 brauchst du den **separaten `iobroker.apsystems`-Adapter**, der die EZ1-Lokal-API deines Inverters anspricht. Ohne den Adapter steht Position 4 leer — als Notlösung kannst du dort `bk215.0.safety.failSafeActive` als Alarm-Indikator binden, bis APsystems eingerichtet ist.

---

## Schritt 3 — Hauptmenü "Energie"

Jaeger hat im Hauptmenü links einen vorgesehenen Eintrag **"Energie"** (siehe Jaeger-README, Slot "Energieverbrauch / Energieüberwachung"). Hier kommt der BK215 als Speicher hinein, daneben dein APsystems-Inverter und der Shelly Pro 3EM als Netzzähler.

### Visualisierungs-Struktur

```text
┌─────────────── Energie ────────────────┐
│                                         │
│  ┌─ Erzeugung ─┐  ┌─ Speicher ─┐  ┌─ Netz ─┐
│  │   APS 800   │→ │  BK215     │→ │ Shelly 3EM│
│  │   xxx W     │  │  yyy %     │  │  zzz W    │
│  │             │  │  -ii W ↓   │  │           │
│  └─────────────┘  └────────────┘  └──────────┘
│                                         │
└─────────────────────────────────────────┘
```

### Slot "Speicher" (BK215)

Im Jaeger-Speicher-Slot folgende Datenpunkte hinterlegen:

| Jaeger-Feld               | Datenpunkt                             | Einheit | Anmerkung                                  |
| ------------------------- | -------------------------------------- | ------- | ------------------------------------------ |
| Ladestand                 | `bk215.0.battery.soc`                  | %       | Hauptanzeige                               |
| Lade-/Entlade-Leistung    | `bk215.0.battery.chargingPower`        | W       | Vorzeichenfreie Zahl                       |
| Status-Indikator          | `bk215.0.battery.localMode`            | bool    | Voraussetzung für Steuerung                |
| Modus-Indikator           | `bk215.0.battery.homeApplianceMode`    | bool    | "Nulleinspeisungsmodus aktiv"              |
| Verbindungs-LED           | `bk215.0.info.connection`              | bool    | Klein, oben rechts in der Speicherkachel   |

### Slot "Netz" (Shelly Pro 3EM)

Hier nutzt du **nicht** den BK215-internen Grid-State (`bk215.0.grid.power`), sondern den **direkten Shelly-Datenpunkt** — er wird höher aufgelöst und ist die Wahrheit (der BK215-State ist nur eine geglättete Spiegelung).

| Jaeger-Feld          | Datenpunkt                                         |
| -------------------- | -------------------------------------------------- |
| Netz-Leistung        | `shelly.0.Shelly3EMPro-XXXXXX.Total.act_power`    |
| Aktuelle Spannung    | `shelly.0.Shelly3EMPro-XXXXXX.EM0.voltage`        |
| Frequenz             | `shelly.0.Shelly3EMPro-XXXXXX.EM0.frequency`      |

> **Reality-check:** Den exakten Shelly-State-Pfad musst du im Object-Browser anpassen — die Geräte-ID hängt von deinem Shelly ab. Wenn der Shelly-Adapter ältere Templates nutzt, heißt das Feld eventuell `Total.power` oder `EM0.total_act_power`.

### Slot "Erzeugung" (APsystems)

Aktuell **leer lassen** oder mit einem manuellen Datenpunkt füllen (ggf. via Skript), denn:

- Der APsystems-Inverter ist im aktuellen Adapter-Stand **nicht direkt angebunden** (UI-Tab "Erweitert" hat einen Stub, aber keine Implementierung)
- Theoretisch kannst du die EZ1-Lokal-API über `iobroker.apsystems` einbinden — eine eigene Inbetriebnahme

Übergangsweise als Erzeugungsanzeige: `bk215.0.battery.chargingPower` *negiert*. Wenn der BK215 auflädt, ist der DC-Strom positiv = Erzeugung. Aber Vorsicht, das ist eine **Krücke** — wenn der BK215 aus dem Speicher entlädt, sieht es aus wie negative Erzeugung. Sauberer ist: Erzeugungs-Slot leer lassen, bis der APsystems-Adapter ergänzt ist.

---

## Schritt 4 — Eigene Seite "Regler"

Jaeger hat keinen vorgesehenen Slot für PI-Regler-Bedienung. Lösung: eine eigene Seite im Hauptmenü als **freie Konfigurationsseite** anlegen (Jaeger erlaubt das laut Doku unter "Frei definierte Oberflächen").

### Layout-Vorschlag

```text
┌──────────── Regler ────────────────────┐
│                                         │
│  [   Regler AN  ]    Setpoint: ___ W ▷ │
│                                         │
│  Diagnose                               │
│  ──────────────────────────────────     │
│  Fehler P-Term:  +12 W                  │
│  Integral I-Term:  240                  │
│  Letzte Schleife:  vor 3 s              │
│                                         │
│  SoC-Grenzen                            │
│  ──────────────────────────────────     │
│  SoC min: ◄═════ 13 % ═══►              │
│  SoC max: ◄═════ 90 % ═══►              │
│                                         │
└─────────────────────────────────────────┘
```

### Widget-Bindings

| Widget-Typ           | Datenpunkt                               | Min / Max  | Hinweis                              |
| -------------------- | ---------------------------------------- | ---------- | ------------------------------------ |
| Toggle-Switch        | `bk215.0.controller.enabled`             | bool       | groß und prominent, oben links       |
| Number-Slider        | `bk215.0.battery.chargingPowerSetpoint`  | 0 – 800 W  | nur wirksam, wenn Regler AUS         |
| Read-only-Wert       | `bk215.0.controller.error`               | —          | Einheit "W", Schwelle ±30 grün       |
| Read-only-Wert       | `bk215.0.controller.integral`            | —          | nur Diagnose, kein Schwellwert       |
| Time-ago             | `bk215.0.controller.lastUpdate`          | —          | "vor X Sekunden" anzeigen            |
| Number-Slider        | `bk215.0.battery.socMinLimit`            | 1 – 20 %   | Speicher übernimmt nach kurzer Zeit  |
| Number-Slider        | `bk215.0.battery.socMaxLimit`            | 70 – 100 % | dito                                 |

> **Wichtige UX-Regel:** Der manuelle Setpoint überschreibt den Regler-Output. Wenn beides gleichzeitig geändert wird, kämpft der Regler dagegen an. Praxis: **Setpoint nur bedienen, wenn Regler AUS ist**. Optional kannst du mit einem JS-Skript erzwingen, dass beim Verstellen von `chargingPowerSetpoint` der Regler automatisch deaktiviert wird.

---

## Schritt 5 — Sicherheits-Verknüpfung

`bk215.0.safety.failSafeActive` ist ein bool — sobald Sicherheitsmodus aktiv ist, wird er `true`. Der zugehörige Klartext steht in `bk215.0.safety.lastReason`.

### Variante A — Direkter Anschluss

In der Statusleiste (Schritt 2, Position 4) direkt `bk215.0.safety.failSafeActive` als Indikator binden:

- `false` → grünes Icon, Text "OK"
- `true` → rotes Icon, Text aus `bk215.0.safety.lastReason`

### Variante B — Globale Alarm-Sammelmeldung (empfohlen)

Wenn du noch andere kritische States hast (Wassersensor, Rauchmelder, was auch immer), lohnt ein **globaler Alarm-Bool** in `0_userdata.0`:

```javascript
// In iobroker.javascript: Skript "global_alarm.js"
const ALARMS = [
    'bk215.0.safety.failSafeActive',
    // weitere Alarm-States hier
];

const TARGET = '0_userdata.0.alarm.global_alarm_active';
const REASON = '0_userdata.0.alarm.global_alarm_reason';

createState(TARGET, false, { type: 'boolean', role: 'indicator.alarm' });
createState(REASON, '', { type: 'string', role: 'text' });

function recompute() {
    const reasons = [];
    let active = false;
    for (const id of ALARMS) {
        const s = getState(id);
        if (s && s.val === true) {
            active = true;
            // Spezialbehandlung für BK215: Klartext mitnehmen
            if (id.startsWith('bk215.0.safety.')) {
                const reasonText = getState('bk215.0.safety.lastReason').val;
                reasons.push(`BK215: ${reasonText}`);
            } else {
                reasons.push(id);
            }
        }
    }
    setState(TARGET, active, true);
    setState(REASON, reasons.join(' | '), true);
}

ALARMS.forEach(id => on({ id, change: 'ne' }, recompute));
on({ id: 'bk215.0.safety.lastReason', change: 'ne' }, recompute);
recompute();
```

In Jaeger dann den globalen Alarm-State binden statt den BK215-State direkt — neue kritische States kommen einfach in das `ALARMS`-Array, ohne Jaeger-Reconfig.

---

## Schritt 6 — Theming-Feinschliff

### Farbschema (passend zu Energie-Domäne)

Ich schlage ein konsistentes Farbschema über alle BK215-Anzeigen vor:

| Datenrolle           | Farbe        | Hex      | Begründung                      |
| -------------------- | ------------ | -------- | ------------------------------- |
| SoC                  | Grün         | `#22c55e` | Universum: voll = grün          |
| Netz-Leistung        | Gelb         | `#facc15` | "Strom" / "Energie"             |
| BK215-Output         | Blau         | `#3b82f6` | Aktor / Steuerung               |
| Fehler / Alarm       | Rot          | `#ef4444` | Konvention                      |
| OK / inaktiv         | Grün         | `#22c55e` |                                 |
| Pausiert / neutral   | Slate-Grau   | `#64748b` |                                 |

### Icon-Empfehlung

Material-Icons, die in Jaeger meist verfügbar sind:

- SoC: `BatteryFull`, `BatteryChargingFull`
- Netz: `FlashOn`, `Bolt`
- BK215: `PowerSettingsNew`, `Storage`
- Regler: `Tune`, `PlayArrow` / `Pause`
- Alarm: `Warning`, `Error`, `CheckCircle`

---

## Inbetriebnahme-Reihenfolge bei dir

In dieser Reihenfolge bist du am schnellsten produktiv:

1. **Schritt 1** (History-Adapter) — Voraussetzung für alles andere mit Verlauf
2. **Schritt 3** (Energie-Hauptmenü) — gibt dir sofort die Live-Übersicht
3. **Schritt 2** (Statusleiste) — die siehst du dann auf jeder Seite
4. **Sanity-Check des Adapters**: BK215 verbindet sich? `info.connection = true`? `battery.soc` füllt sich? Wenn nein → Setup-de.md aus dem Adapter-Repo
5. **Schritt 5** (Alarm-Verknüpfung) — bevor du den Regler scharf schaltest
6. **Schritt 4** (Regler-Seite) — zuletzt, weil du den Regler erst nach erfolgreicher manueller Steuerung aktivierst

---

## Bekannte Stolperfallen mit Jaeger + BK215

| Problem                                            | Ursache                                                          | Lösung                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| BK215-Speicher-Slot zeigt "0 %" statt SoC          | `battery.soc` noch nie gefüllt                                   | Adapter-Log prüfen, Local Mode in der Sunlit-App aktivieren                         |
| Setpoint-Slider hat keine Wirkung                  | `battery.localMode = false`                                      | Sunlit-App → Lokaler Modus → AN                                                     |
| Regler-Toggle springt sofort wieder zurück         | Sicherheits-Voraussetzungen nicht erfüllt (Grid-State, SoC, Link) | `safety.lastReason` lesen, Ursache beheben                                          |
| Charts bleiben leer                                | History-Adapter nicht aktiviert                                  | Schritt 1 erneut prüfen                                                              |
| Statusleiste-Wert "Netz" ist verzögert             | Shelly-Update-Frequenz ist niedriger als Jaeger-Refresh          | Im Shelly-Adapter "Update interval" verkürzen oder "Push notifications" aktivieren  |
| Alarm-Indikator bleibt gelegentlich "AKTIV" hängen | `safety.failSafeActive` wurde nicht zurückgesetzt                | Adapter-Bug? Im aktuellen Stand setzt der Scheduler den State korrekt zurück        |

---

## Wenn du irgendwo nicht weiterkommst

Das wahrscheinlichste Szenario: ein Jaeger-Slot heißt in deiner Version anders als oben. In diesem Fall:

1. Im Jaeger-Konfig-UI nachschauen, welche Slots tatsächlich existieren
2. Die **Logik** aus diesem Dokument auf die echten Slots übertragen — die Datenpunkt-Bindings stimmen, nur der Container-Name ist anders
3. Bei Bedarf das Jaeger-Tutorial-Video (auf YouTube) als Referenz, dort werden die Slots live demonstriert

Bei strukturellen Problemen (z. B. Jaeger lässt keinen Speicher-Typ "BK215" zu) — Issue im BK215-Adapter-Repo aufmachen, ich erweitere dann die Doku mit deinen konkreten Slot-Namen.
