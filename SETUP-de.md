# Inbetriebnahme — Schritt für Schritt

Diese Anleitung führt dich durch die Erst-Einrichtung des Adapters auf deinem `iobroker-slave` (192.168.178.225).

## 1. Voraussetzungen prüfen

### BK215-Firmware

Öffne die Sunlit-Solar-App → Gerät auswählen → Einstellungen → Geräteinformation:

- **BK215**: Firmware muss `≥ 1.5.7` sein
- **BK215 Plus**: Firmware muss `≥ 4.0.3` sein

Falls die Version niedriger ist, in der App das OTA-Update durchführen.

### Lokalen Modus aktivieren

In der Sunlit-App:

1. Gerät auswählen
2. Einstellungen → "Lokaler Modus" / "Local Mode"
3. Aktivieren

> **Wichtig:** Ohne aktiven lokalen Modus akzeptiert das Gerät keine Befehle vom Adapter. Der Adapter wird dann den Sicherheitsmodus mit Grund `bk215-local-mode-off` setzen.

### Shelly Pro 3EM-Datenpunkt

Öffne in deinem ioBroker den Object-Browser und suche den Pfad zur saldierten Wirkleistung. Typische Pfade:

- `shelly.0.Shelly3EMPro-XXXXXXXXX.Total.act_power` (saldiert über alle Phasen)
- `shelly.0.Shelly3EMPro-XXXXXXXXX.EM0.total_act_power` (Alternative je nach Firmware)

Notiere den vollständigen Pfad. Der Wert sollte:

- positiv sein, wenn du Strom aus dem Netz beziehst
- negativ sein, wenn du einspeist

## 2. Adapter installieren

Auf dem `iobroker-slave`:

```bash
# Im Master-ioBroker-Admin: Adapter → Custom installieren
# URL: https://github.com/Sven-83/sunlit/tarball/main
```

Oder als lokales tarball aus dem Build-Ordner:

```bash
cd ~/iobroker.bk215
npm install
npm run build
iobroker url file:$(pwd) --host iobroker-slave
```

> Der Hostname `iobroker-slave` sorgt dafür, dass der Adapter auf dem richtigen Pi installiert wird, nicht auf dem Master.

## 3. Instanz konfigurieren

Im ioBroker-Admin → Instanzen → bk215.0 → Einstellungen.

### Tab "Verbindung"

- **IP-Adresse:** `192.168.178.24` (BK215)
- **Seriennummer:** `dcbdccc00361`
- mDNS-Discovery: optional, IP ist bereits bekannt

### Tab "Netzzähler"

Shelly-Pfad eintragen — **Wirkleistung** (nicht Scheinleistung):
- `shelly.2.shellypro3em#2cbcbba6d978#1.EM0.TotalActivePower`

> Bitte im Object-Browser prüfen ob dieser State existiert — alternativ `EM0.act_power` oder `Total.act_power`.

### Tab "Regler"

- **Regler aktivieren: AUS** (Lösung C — Sunlit-App regelt)
- Inverter-Maximum: `800` W
- Tastverhältnis: `4000` ms

### Tab "Sicherheit"

- SoC min: `20` %
- SoC max: `100` %
- Puffer: `3` Prozentpunkte → effektive Untergrenze 23 %

### Tab "Erweitert"

- APsystems-Inverter: vorerst aus. Direktanbindung kommt in einem späteren Release.
- Cloud-API-Token: leer lassen.
- Log-Level: `info`. Nach erfolgreicher Inbetriebnahme auf `warn` zurückstellen, damit das Log ruhiger wird.

## 4. Erste Inbetriebnahme — Checkliste

Nach dem Speichern der Konfiguration den Adapter starten und im Log beobachten:

```
[INFO] BK215 adapter starting up (instance bk215.0)
[INFO] Discovered BK215 at 192.168.178.X            ← bei mDNS
[INFO] Connected to BK215 at 192.168.178.X:8000
[INFO] Grid reader subscribed to shelly.0…
```

### Sanity-Check der States

Im Object-Browser unter `bk215.0`:

| State                       | Erwarteter Wert nach 10 s              |
| --------------------------- | -------------------------------------- |
| `info.connection`           | `true`                                 |
| `battery.soc`               | aktueller SoC (z.B. 65)                |
| `battery.localMode`         | `true`                                 |
| `battery.chargingPower`     | aktuelle Ist-Ausgangsleistung in W     |
| `grid.power`                | Echtzeit-Netzleistung vom Shelly       |
| `grid.stale`                | `false`                                |
| `safety.failSafeActive`     | `false`                                |

Wenn `battery.localMode = false` ist: zurück in die Sunlit-App und Local Mode aktivieren.

### Manueller Funktionstest

Ohne Regler — direkt den BK215 ansteuern:

1. `battery.chargingPowerSetpoint` auf z.B. `200` schreiben
2. Im Log sollte `TX: {"code":24662,"data":{"t590":200}}` erscheinen
3. Nach kurzer Zeit sollte `battery.chargingPower` den Wert spiegeln
4. Auf 0 zurücksetzen

### Regler aktivieren

Wenn alles oben passt, `controller.enabled` auf `true` setzen. Im Log:

```
[INFO] Zero-feed scheduler running every 4000 ms
```

Beobachte für ein paar Minuten:

- `controller.error` sollte gegen 0 schwingen
- `controller.integral` baut sich langsam auf
- `grid.power` pendelt eng um 0

## 5. Was tun, wenn …

| Symptom                                            | Ursache und Behebung                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `info.connection` bleibt `false`                   | IP falsch, falsches VLAN, Port 8000 blockiert, Local Mode aus, FW zu alt            |
| Nur kurz `true`, dann wieder `false` im Minutentakt | Idle-Watchdog feuert. Heisst: Gerät streamt nicht. Lokalen Modus prüfen, FW prüfen   |
| `safety.lastReason = grid-data-stale`              | Shelly liefert nicht. Shelly-Adapter prüfen, ggf. `gridStaleTimeoutS` höher setzen  |
| Regler oszilliert sichtbar                         | Kp halbieren (0.7 → 0.35), oder Tastverhältnis auf 5000 ms erhöhen                  |
| Regler erreicht nie 0                              | Ki erhöhen (0.05 → 0.08), Totzone prüfen — ist die zu groß?                          |

## 6. Backup nicht vergessen

Da dein Master-Backitup gerade bekanntermaßen (TODO: 1.440 Min Intervall) noch korrigiert wird: bevor du den Regler scharf schaltest, einmal manuell ein Backup ziehen — der Adapter modifiziert die Datenbank, und ein Rollback-Pfad ist Gold wert.

## Quellcode und Issue-Tracker

- Repository: <https://github.com/Sven-83/sunlit>
- Issues / Diskussion: dort

Bei Fehlern bitte das Log-Fragment mit `safety.lastReason` und der vorhergehenden 30 Sekunden mitschicken.
