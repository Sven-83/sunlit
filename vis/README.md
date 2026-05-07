# BK215 Visualisierung

Dieser Ordner enthält die Dokumentation für die Frontend-Integration des BK215-Adapters.

## Verwendete Frontend

**[Jaeger Design Adapter](https://github.com/ioBroker/ioBroker.vis-2-widgets-jaeger-design)** auf VIS-2.

→ Setup-Anleitung: [`jaeger-setup.md`](jaeger-setup.md)

## Datenpunkt-Übersicht

Die wichtigsten States, die in jedem Frontend gebunden werden:

```text
bk215.0.info.connection                  bool — TCP-Link aktiv
bk215.0.info.lastSync                    number — Timestamp
bk215.0.info.firmwareVersion             string

bk215.0.battery.soc                      number 0–100 (%)
bk215.0.battery.chargingPower            number — Ist-Output (W)
bk215.0.battery.chargingPowerSetpoint    number, R/W — manueller Setpoint
bk215.0.battery.localMode                bool, R/W
bk215.0.battery.homeApplianceMode        bool, R/W
bk215.0.battery.socMinLimit              number 1–20, R/W
bk215.0.battery.socMaxLimit              number 70–100, R/W

bk215.0.grid.power                       number — geglättete Netzleistung (W)
bk215.0.grid.lastUpdate                  number — Timestamp
bk215.0.grid.stale                       bool — Daten älter als Timeout

bk215.0.controller.enabled               bool, R/W
bk215.0.controller.error                 number — aktueller PI-Fehler (W)
bk215.0.controller.integral              number — persistierter I-Term
bk215.0.controller.lastUpdate            number — Timestamp

bk215.0.safety.failSafeActive            bool — Sicherheitsmodus
bk215.0.safety.lastReason                string — Klartext-Begründung
```

## Falls du später ein anderes Frontend nutzen willst

Die Setup-Anleitung ist Jaeger-spezifisch, aber der **logische Aufbau** (4 Bereiche: Übersicht, Regler, Verlauf, Diagnose) lässt sich auf andere Frontends übertragen — Material Design, JarvisJS, iQontrol, sogar Lovelace. Die Datenpunkt-Bindings sind identisch.
