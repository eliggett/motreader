"""Command-line tool: Spectra archive <-> CSV (modes) + YAML (radio data).

    python -m motreader.cli export  <archive> <outdir>
    python -m motreader.cli import  <template_archive> <outdir> <new_archive>
    python -m motreader.cli decode  <archive> [outfile.bin]   # raw decrypted body
    python -m motreader.cli add-mode <archive> <new_archive> <after> [copy=N] [name=TEXT] [zones=1,3]
        # insert a new mode after mode <after> (0 = first): a copy of mode N
        # (default: mode <after>), named TEXT (default "MODE  nn", A9 head
        # "  MODE   nn"; 8 / 11 chars max), in zones
        # (required with Zone Operation on); later modes renumber, like RSS
    python -m motreader.cli delete-mode <archive> <new_archive> <mode>
    python -m motreader.cli add-zone <archive> <new_archive> <position> modes=1,5,9 [name=TEXT]
        # insert a zone at <position> (later zones renumber, the home zone
        # follows) holding the modes, named TEXT (default "ZONE  nn")
    python -m motreader.cli delete-zone <archive> <new_archive> <zone>
    python -m motreader.cli remove-trunking <archive> <new_archive>
        # TRUNKED DUAL MODE: turn the (last) trunked mode 1 into a conventional
        # mode (a copy of mode 2: re-export and edit it) and drop the trunking
        # personality/system data; RSS then shows MAX SYSTEMS/SUBFLEETS 00 and
        # "No Trunking data loaded" (motreader/trunking.py)
    python -m motreader.cli read-radio <serial_port> <outdir>
        # read a radio over a RIB (read-only; notes/RADIO-PROTOCOL.md): writes
        # codeplug.bin (EEPROM from 0x6000), mcu.json, radio.log and an
        # archive A<serial>; the archive's 6 radio-sourced prefix bytes are not
        # matches what RSS saves from the same radio (except its nonce and
        # 17 bookkeeping bytes RSS rewrites)
    python -m motreader.cli dump-radio <serial_port> <outdir> [codeplug|mcu|both] [--registers]
        # read every address each session answers (read-only): codeplug
        # session (scrambled; EEPROM at 0x6000, ROM) and/or MCU session (RAM,
        # internal EEPROM 0xB6xx). Skips the 68HC11 register block
        # 0x1000-0x103F unless --registers. Writes <session>_space.bin (0xFF
        # where unread), dump_map.json, and the regions split out: ram.bin,
        # firmware_low.bin, codeplug_eeprom.bin, codeplug.bin, firmware.bin,
        # mcu_eeprom.bin (codeplug_ext.bin on S9000e radios), README.txt.
        # A full session takes ~11 minutes.
    python -m motreader.cli write-radio <serial_port> <archive> <outdir> --yes [--clone] [--ignore-features]
        # program a radio with an archive's codeplug, the way RSS does. Reads
        # the radio first (backup in <outdir>/backup), refuses unless the
        # model and serial match and the codeplug fits the 8 KB EEPROM, then
        # verifies by reading back. --clone (RSS's CLONE): another radio of
        # the same model; the radio keeps its serial number, and the
        # archive's options must match the radio's (--ignore-features)

Export writes one CSV per multi-row category (modes.csv, phones.csv, mpl.csv,
buttons.csv)
and a YAML for the
single-record radio data (radio.yaml; with zones, each zone's scan list and
ZONE SCAN OPTIONS are under zones[].scan). Import uses template-patch: it starts
from the template archive, applies the CSV/YAML, re-encrypts (keeping the
original nonce), and verifies the result decodes back to the same values.
"""

from __future__ import annotations

import csv
import os
import sys

import yaml

from . import buttons, convscan, lists, modeops, radiowide, scanlist, trunking, zonelist, zoneop
from .archive import Archive
from .codeplug import Codeplug, mode_pointer_table
from .crypto import decrypt_body, encrypt_body


def export(archive_path: str, outdir: str) -> None:
    os.makedirs(outdir, exist_ok=True)
    arc = Archive.load(archive_path)
    body = decrypt_body(arc.body)
    cp = Codeplug.parse(body)

    # zones off: per-mode SCAN settings + Mode Slave scan lists (convscan.py)
    try:
        conv, mscan = convscan.decode(body)
    except ValueError:
        conv, mscan = None, []
    mscan = {r.mode: r for r in mscan}
    modes_csv = os.path.join(outdir, "modes.csv")
    with open(modes_csv, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["mode", "name", "rx_mhz", "tx_mhz", "ta_mhz",
                    "rx_pl", "tx_pl", "ta_pl",
                    "rx_squelch_type", "tx_squelch_type", "ta_squelch_type",
                    "tx_power", "ta_power", "up_xtal_shift",
                    "mdc_ptt_id", "phone_encode", "mpl_type",
                    "audio_compander", "adaptive_splatter",
                    "reverse_burst_toc", "unmute_mute_type"]
                   + (SCAN_COLS if conv else []) + ["raw_hex"])
        for m in cp.modes:
            sc = mscan.get(m.number)
            w.writerow(
                [m.number, m.name, m.rx_mhz, m.tx_mhz, m.ta_mhz,
                 m.rx_pl or "", m.tx_pl or "", m.ta_pl or "",
                 m.rx_squelch_type or "", m.tx_squelch_type or "", m.ta_squelch_type or "",
                 m.tx_power or "", m.ta_power or "", m.up_xtal_shift or "",
                 m.mdc_ptt_id or "", m.phone_encode or "", m.mpl_type or "",
                 m.audio_compander or "", m.adaptive_splatter or "",
                 m.reverse_burst_toc or "", m.unmute_mute_type or ""]
                + (_scan_cells(sc) if conv else []) + [m.raw.hex()]
            )

    # Radio-wide lists (RSS CONVENTIONAL -> PHONE LIST / MPL LIST)
    phones_csv = os.path.join(outdir, "phones.csv")
    with open(phones_csv, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["phone", "name", "number"])
        for ph in lists.decode_phones(cp):
            w.writerow([ph.number, ph.name, ph.dial])
    mpls = lists.decode_mpls(cp)
    mpl_csv = os.path.join(outdir, "mpl.csv")
    if mpls:
        with open(mpl_csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["mpl", "name", "rx_type", "rx_code", "tx_type", "tx_code",
                        "ta_type", "ta_code"])
            for m in mpls:
                w.writerow([m.number, m.name, m.rx_type, m.rx_code, m.tx_type,
                            m.tx_code, m.ta_type, m.ta_code])
    elif os.path.exists(mpl_csv):
        os.remove(mpl_csv)          # stale from an earlier export

    btns = buttons.decode_buttons(cp)
    buttons_csv = os.path.join(outdir, "buttons.csv")
    if btns:
        with open(buttons_csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["button", "function", "name", "code", "editable"])
            for b in btns:
                w.writerow([b.button, b.function, b.name, b.code, "yes" if b.editable else "no"])
    elif os.path.exists(buttons_csv):
        os.remove(buttons_csv)

    radio = {
        "serial": cp.serial,
        "model": cp.model,
        "band": cp.band,
        "signature": cp.signature,
        "banner": "long" if len(arc.banner) == 0x53 else "short",
        "body_len": len(body),
        "mode_count": len(cp.modes),
    }
    # Radio-wide settings (RSS RADIO-WIDE / OPTIONS / CONVENTIONAL screens),
    # values in RSS wording. See motreader/radiowide.py for the field map.
    rw = radiowide.decode(body, cp.band)
    if rw:
        radio["radio_wide"] = rw
    # Zones (radio-wide): name + mode membership. `modes` (mode numbers) is the
    # authoritative, importable field; `mode_names` is a read-only convenience
    # (ignored on import). `scan` is the zone's scan list + ZONE SCAN OPTIONS
    # (RSS wording; priority_1/2 = a mode number, SELMOD or null; `modes` = the
    # non-priority members besides <SELMOD>, which is always on the list).
    # zones off: CONVENTIONAL SCAN TYPE / list types and the radio-wide
    # (Op Select) scan list; per-mode settings and Mode Slave lists: modes.csv
    if conv is not None:
        radio["conventional_scan"] = {k: v for k, v in vars(conv).items()
                                      if not (v is None and k in ("modes",))}
    if cp.zones:
        name_of = {m.number: m.name for m in cp.modes}
        scans = {s.zone: s for s in scanlist.decode(body)}
        radio["zones"] = []
        for z in cp.zones:
            row = {
                "number": z.number,
                "name": z.name,
                "modes": z.modes,
                "mode_names": [name_of.get(n, f"MODE {n}") for n in z.modes],
            }
            s = scans.get(z.number)
            if s is not None:
                row["scan"] = {k: v for k, v in vars(s).items() if k != "zone"}
            radio["zones"].append(row)

    radio_yaml = os.path.join(outdir, "radio.yaml")
    with open(radio_yaml, "w") as fh:
        yaml.safe_dump(radio, fh, sort_keys=False)
    zmsg = f", {len(cp.zones)} zones" if cp.zones else ""
    print(f"wrote {modes_csv} ({len(cp.modes)} modes{zmsg}), {phones_csv}"
          + (f", {mpl_csv} ({len(mpls)} MPL)" if mpls else "") + f" and {radio_yaml}")


SCAN_COLS = ["scan", "scan_button_control", "coded_squelch_scan", "talkback_scan",
             "scan_priority_1", "scan_priority_2", "scan_list"]


def _scan_cells(sc) -> list:
    if sc is None:
        return [""] * len(SCAN_COLS)
    pri = lambda p: "" if p is None else str(p)
    return [sc.scan, sc.scan_button_control, sc.coded_squelch_scan, sc.talkback_scan,
            pri(sc.priority_1), pri(sc.priority_2),
            "" if sc.modes is None else " ".join(str(x) for x in sc.modes)]


def _scan_row(row: dict, mode: int):
    """A convscan.ModeScan from modes.csv's scan columns, or None."""
    if not any(row.get(c) for c in SCAN_COLS[:4]):
        return None
    pri = lambda v: None if not (v or "").strip() else (
        v.strip() if not v.strip().isdigit() else int(v))
    lst = row.get("scan_list")
    return convscan.ModeScan(
        mode=mode, scan=row.get("scan") or None,
        scan_button_control=row.get("scan_button_control") or None,
        coded_squelch_scan=row.get("coded_squelch_scan") or None,
        talkback_scan=row.get("talkback_scan") or None,
        priority_1=pri(row.get("scan_priority_1")), priority_2=pri(row.get("scan_priority_2")),
        modes=None if lst is None else [int(x) for x in lst.replace(",", " ").split()])


def do_import(template_path: str, outdir: str, new_path: str) -> None:
    arc = Archive.load(template_path)
    body = decrypt_body(arc.body)
    radio_yaml = os.path.join(outdir, "radio.yaml")
    rdata = {}
    if os.path.exists(radio_yaml):
        with open(radio_yaml) as fh:
            rdata = yaml.safe_load(fh) or {}
    # ZONE OPERATION first: switching it re-packs the whole codeplug (zone
    # tables <-> per-mode scan lists), so every other edit applies on top of
    # the re-packed body. Zones / home zone from the old export describe the
    # old layout and are not applied in the same import.
    zone_switched = False
    want_zo = (rdata.get("radio_wide") or {}).get("zone_operation")
    if want_zo is not None and str(want_zo) != radiowide.decode(body).get("zone_operation"):
        try:
            body = zoneop.zones_on(body) if str(want_zo) == "Enabled" else zoneop.zones_off(body)
        except ValueError as e:
            raise SystemExit(f"radio_wide.zone_operation: {e}")
        zone_switched = True
        print(f"zone_operation -> {want_zo}: codeplug re-packed"
              + (" (one zone 'ZONE  01' with every mode, home zone 1)" if want_zo == "Enabled"
                 else " (all zones removed)")
              + "; zones/home_zone in radio.yaml not applied this time: re-export to edit them")
    # zones off: CONVENTIONAL SCAN TYPE / list types re-pack the mode records
    # (Mode Slave lists live after each record), so they go first too; the
    # scan lists of the old layout are then not applied (re-export to edit)
    want_cs = rdata.get("conventional_scan") if not zone_switched else None
    scan_switched = False
    if want_cs:
        try:
            cur_cs = convscan.decode(body)[0]
        except ValueError:
            cur_cs = None
        if cur_cs is not None:
            st = want_cs.get("scan_type", cur_cs.scan_type)
            nl = want_cs.get("non_priority_list", cur_cs.non_priority_list)
            pl = want_cs.get("priority_list", cur_cs.priority_list)
            try:
                b0 = body
                if cur_cs.scan_type == "Talkgroup" and str(st) != "Talkgroup":
                    body = convscan.set_scan_type(body, st)
                body = convscan.set_list_types(body, nl, pl)
                body = convscan.set_scan_type(body, st)
            except ValueError as e:
                raise SystemExit(f"conventional_scan: {e}")
            scan_switched = body != b0
            if scan_switched:
                print("conventional_scan: list type / scan type changed, codeplug re-packed; "
                      "scan lists in modes.csv / radio.yaml not applied this time: re-export "
                      "to edit them")
    cp = Codeplug.parse(body)
    scan_rows = []
    # after a re-pack the lists of the old export don't apply: keep the new ones
    keep_lists = {r.mode: r for r in convscan.decode(body)[1]} if scan_switched else {}

    # apply modes.csv (only the mapped, editable columns)
    modes_csv = os.path.join(outdir, "modes.csv")
    if os.path.exists(modes_csv):
        by_num = {m.number: m for m in cp.modes}
        with open(modes_csv, newline="") as fh:
            for row in csv.DictReader(fh):
                m = by_num.get(int(row["mode"]))
                sr = _scan_row(row, int(row["mode"]))
                if sr is not None:
                    k = keep_lists.get(sr.mode)
                    if k is not None:
                        sr.priority_1, sr.priority_2, sr.modes = k.priority_1, k.priority_2, k.modes
                    scan_rows.append(sr)
                if m is not None:
                    if row.get("name") is not None:
                        m.name = row["name"]
                    if row.get("rx_mhz"):
                        m.rx_mhz = float(row["rx_mhz"])
                    if row.get("tx_mhz"):
                        m.tx_mhz = float(row["tx_mhz"])
                    if row.get("ta_mhz"):
                        m.ta_mhz = float(row["ta_mhz"])
                    # tone codes: a PL tone ("141.3"), a DPL code ("D411"), or
                    # empty = Carrier (when its squelch type is empty/Carrier)
                    for k in ("rx", "tx", "ta"):
                        if f"{k}_pl" in row and row[f"{k}_pl"] is not None:
                            setattr(m, f"{k}_pl", row[f"{k}_pl"].strip() or None)
                    for col in ("tx_power", "ta_power", "up_xtal_shift",
                                "mdc_ptt_id", "phone_encode", "mpl_type",
                                "audio_compander", "adaptive_splatter",
                                "reverse_burst_toc", "unmute_mute_type",
                                # squelch TYPE carries DPL polarity (DPL vs
                                # INV.DPL) and "Carrier" for an empty code
                                "rx_squelch_type", "tx_squelch_type",
                                "ta_squelch_type"):
                        if row.get(col):
                            setattr(m, col, row[col])

    # apply zones from radio.yaml (name + mode membership; flags preserved)
    if rdata and cp.zones and not zone_switched:
        by_znum = {z.number: z for z in cp.zones}
        for zrow in (rdata.get("zones") or []):
            z = by_znum.get(zrow.get("number"))
            if z is None:
                continue
            if zrow.get("name") is not None:
                z.name = str(zrow["name"])
            if zrow.get("modes") is not None:
                modes = [int(x) for x in zrow["modes"]]
                if not modes:
                    raise SystemExit(
                        f"zone {z.number} ({z.name!r}) has no modes; RSS deletes "
                        "empty zones on save. Keep at least one mode or remove the zone.")
                z.modes = sorted(set(modes))

    new_body = bytearray(cp.rebuild())
    # apply phones.csv / mpl.csv (change-gated per field)
    phones_csv = os.path.join(outdir, "phones.csv")
    if os.path.exists(phones_csv):
        with open(phones_csv, newline="") as fh:
            rows = [lists.Phone(int(r["phone"]), r["name"], r["number"])
                    for r in csv.DictReader(fh)]
        lists.encode_phones(cp, new_body, rows)
    mpl_csv = os.path.join(outdir, "mpl.csv")
    if os.path.exists(mpl_csv):
        with open(mpl_csv, newline="") as fh:
            rows = [lists.Mpl(int(r["mpl"]), r["name"], r["rx_type"], r["rx_code"],
                              r["tx_type"], r["tx_code"], r["ta_type"], r["ta_code"])
                    for r in csv.DictReader(fh)]
        lists.encode_mpls(cp, new_body, rows)
    buttons_csv = os.path.join(outdir, "buttons.csv")
    if os.path.exists(buttons_csv):
        with open(buttons_csv, newline="") as fh:
            rows = [buttons.Button(r["button"], r["function"]) for r in csv.DictReader(fh)]
        buttons.encode_buttons(cp, new_body, rows)
    new_body = bytes(new_body)
    # zones off: per-mode SCAN settings / Mode Slave lists (modes.csv) and the
    # radio-wide Op Select list (radio.yaml conventional_scan); in place
    if want_cs or scan_rows:
        try:
            cur_cs = convscan.decode(new_body)[0]
            if cur_cs is not None:
                conv_in = None
                if want_cs and not scan_switched:
                    conv_in = convscan.ConvScan(**{**vars(cur_cs), **{
                        k: v for k, v in want_cs.items() if k in vars(cur_cs)}})
                new_body = convscan.encode(new_body, conv_in, scan_rows)
        except ValueError as e:
            raise SystemExit(f"scan: {e}")
    # zone scan lists + ZONE SCAN OPTIONS (radio.yaml zones[].scan; in place)
    if rdata and cp.zones and not zone_switched:
        scans = []
        for zrow in (rdata.get("zones") or []):
            sc = zrow.get("scan")
            if sc and zrow.get("number") is not None:
                fields = {k: sc[k] for k in vars(scanlist.ZoneScan(0)) if k in sc and k != "zone"}
                scans.append(scanlist.ZoneScan(zone=int(zrow["number"]), **fields))
        if scans:
            try:
                new_body = scanlist.encode(new_body, scans)
            except ValueError as e:
                raise SystemExit(f"zones[].scan: {e}")
    # apply radio-wide settings (change-gated; ext-section checksum kept valid)
    rw_in = dict(rdata.get("radio_wide") or {})
    if zone_switched:                 # set by the re-pack (RSS rule: home mode in home zone)
        rw_in.pop("home_zone", None)
        rw_in.pop("zone_operation", None)
    if rw_in:
        new_body = bytes(radiowide.encode(new_body, rw_in))
    # A9 heads: keep the control-head checksum over the ASCII name block valid
    # (mode/zone/phone/MPL name edits), else RSS warns on GET.
    new_body = bytearray(new_body)
    lists.fix_a9_head_checksum(cp, new_body)
    new_body = bytes(new_body)
    new_cipher = encrypt_body(new_body)
    Archive(body=new_cipher, banner=arc.banner).save(new_path)

    # verify: re-decode and compare the editable fields
    check = Codeplug.parse(decrypt_body(Archive.load(new_path).body))
    ok = all(
        (a.rx_mhz, a.tx_mhz, a.ta_mhz, a.tx_power, a.ta_power, a.up_xtal_shift,
         a.mdc_ptt_id, a.phone_encode, a.mpl_type,
         a.audio_compander, a.adaptive_splatter,
         a.reverse_burst_toc, a.unmute_mute_type) ==
        (b.rx_mhz, b.tx_mhz, b.ta_mhz, b.tx_power, b.ta_power, b.up_xtal_shift,
         b.mdc_ptt_id, b.phone_encode, b.mpl_type,
         b.audio_compander, b.adaptive_splatter,
         b.reverse_burst_toc, b.unmute_mute_type)
        for a, b in zip(cp.modes, check.modes)
    )
    if rw_in:
        got = radiowide.decode(check.body)
        want = radiowide.decode(new_body)
        ok = ok and got == want
    want_cp = Codeplug.parse(new_body)
    ok = ok and lists.decode_phones(check) == lists.decode_phones(want_cp) \
        and lists.decode_mpls(check) == lists.decode_mpls(want_cp) \
        and buttons.decode_buttons(check) == buttons.decode_buttons(want_cp) \
        and scanlist.decode(check.body) == scanlist.decode(new_body) \
        and convscan.decode(check.body) == convscan.decode(new_body)
    print(f"wrote {new_path}; verify round-trip (freqs + options): {'OK' if ok else 'FAIL'}")
    _report_changes(body, new_body, cp)


def _report_changes(template_body: bytes, new_body: bytes, cp: Codeplug) -> None:
    """Show exactly which bytes the write path changed, proving it is a
    template-patch: everything not listed (incl. features motreader does not
    understand) is preserved verbatim from the source codeplug."""
    diffs = [i for i in range(min(len(template_body), len(new_body)))
             if template_body[i] != new_body[i]]
    if not diffs:
        print("  unchanged: output is byte-identical to the source (all "
              "features, known and unknown, preserved).")
        return
    # attribute each changed byte to a mode record, a zone, else "other"
    # each mode's TRUE record (RSS's pointer table: start .. next start), which
    # holds its tone slots and 8-bit sum; else the parser's record view
    pt = mode_pointer_table(template_body)
    if pt is not None:
        st = pt[2]
        ends = st[1:] + [st[-1] + template_body[0x10A]]
        spans = sorted((a, e, i + 1) for i, (a, e) in enumerate(zip(st, ends)))
    else:
        spans = sorted((m.offset, m.offset + len(m.raw), m.number)
                       for m in cp.modes if m.offset >= 0)
    if cp.ascii_names is not None:          # A9: names live in an ASCII table
        start, w = cp.ascii_names
        spans += [(start + (m.number - 1) * w, start + m.number * w, m.number)
                  for m in cp.modes]
    zspans = []  # (lo, hi, zone-number, kind)
    for z in cp.zones:
        if z.names_off >= 0:
            zspans.append((z.names_off, z.names_off + z.name_w, z.number, "name"))
        if z.memb_off >= 0:
            zspans.append((z.memb_off, z.memb_off + z.memb_w, z.number, "modes"))
    zspans += [(i, i + 1, zn, "scan") for i, zn in scanlist.offsets(template_body).items()]
    rw_offs = radiowide.field_offsets(template_body)
    tcp = Codeplug.parse(template_body)
    list_offs = {i: "phone list" for i in lists.phone_offsets(tcp)}
    list_offs.update({i: "MPL list" for i in lists.mpl_offsets(tcp)})
    list_offs.update({i: "button map" for i in buttons.button_offsets(tcp)})
    list_offs.update({i: "scan list" for i, mn in convscan.offsets(template_body).items()
                      if mn == 0} if convscan.layout(template_body) else {})
    ck = lists.a9_head_checksum_off(tcp)
    if ck is not None:
        list_offs.update({ck: "A9 head checksum", ck + 1: "A9 head checksum"})
    list_hit = set()
    by_mode: dict = {}
    by_zone: dict = {}
    rw_hit = False
    other = []
    for i in diffs:
        if i in rw_offs:
            rw_hit = True
            continue
        if i in list_offs:
            list_hit.add(list_offs[i])
            continue
        hit = next((n for lo, hi, n in spans if lo <= i < hi), None)
        if hit is not None:
            by_mode.setdefault(hit, []).append(i)
            continue
        zhit = next(((n, k) for lo, hi, n, k in zspans if lo <= i < hi), None)
        if zhit is not None:
            by_zone.setdefault(zhit[0], set()).add(zhit[1])
        else:
            other.append(i)
    parts = [f"mode {n} ({len(v)}B)" for n, v in sorted(by_mode.items()) if n is not None]
    zparts = [f"zone {n} ({'+'.join(sorted(k))})" for n, k in sorted(by_zone.items())]
    # name the radio-wide fields by decoded value (several share a byte)
    rw_old, rw_new = radiowide.decode(template_body), radiowide.decode(new_body)
    by_rw = [k for k in rw_new if rw_old.get(k) != rw_new[k]] if rw_hit else []
    segs = parts + zparts + ([f"radio-wide ({', '.join(by_rw)})"] if by_rw else []) \
        + sorted(list_hit)
    print(f"  changed {len(diffs)} byte(s) in {len(by_mode)} mode(s)"
          + (f", {len(by_zone)} zone(s)" if by_zone else "") + ": "
          + (", ".join(segs) if segs else "none"))
    if other:
        print(f"  NOTE: {len(other)} changed byte(s) outside any mode record "
              f"(offsets {[hex(i) for i in other[:8]]}) — review before flashing.")
    print("  everything else preserved verbatim from the source codeplug "
          "(unknown/unmapped per-mode features kept at their safe template values).")


def decode(archive_path: str, outfile: str | None) -> None:
    arc = Archive.load(archive_path)
    body = decrypt_body(arc.body)
    if outfile:
        with open(outfile, "wb") as fh:
            fh.write(body)
        print(f"wrote {outfile} ({len(body)} bytes)")
    else:
        sys.stdout.buffer.write(body)


def remove_trunking(src: str, dst: str) -> None:
    arc = Archive.load(src)
    body = decrypt_body(arc.body)
    try:
        new = trunking.remove_trunking(body)
    except ValueError as e:
        raise SystemExit(f"remove-trunking: {e}")
    Archive(body=encrypt_body(new), banner=arc.banner).save(dst)
    a = Codeplug.parse(body)
    c = Codeplug.parse(decrypt_body(Archive.load(dst).body))
    key = lambda m: (m.rx_mhz, m.tx_mhz, m.ta_mhz, m.name, m.rx_pl, m.tx_pl)
    ok = [key(m) for m in a.modes[1:]] == [key(m) for m in c.modes[1:]] \
        and [(z.name, z.modes) for z in a.zones] == [(z.name, z.modes) for z in c.zones] \
        and trunking.trunking_info(new) is None
    m1 = c.modes[0]
    print(f"wrote {dst}; verify (modes 2-{len(c.modes)}, zones unchanged, no trunking left): "
          f"{'OK' if ok else 'FAIL'}")
    print(f"  mode 1 ({a.modes[0].name!r}, was trunked) is now conventional, a copy of mode 2: "
          f"{m1.rx_mhz} / {m1.tx_mhz} MHz. Export and edit it (name, freqs, tones).")


def mode_op(src: str, dst: str, op: str, args: list[str]) -> None:
    arc = Archive.load(src)
    body = decrypt_body(arc.body)
    a = Codeplug.parse(body)
    try:
        if op == "add":
            kw = dict(x.split("=", 1) for x in args[1:])
            after = int(args[0])
            new = modeops.add_mode(
                body, after,
                copy_from=int(kw["copy"]) if "copy" in kw else None,
                name=kw.get("name"),
                zones=[int(z) for z in kw.get("zones", "").split(",") if z])
        else:
            after = int(args[0])
            new = modeops.delete_mode(body, after)
    except (ValueError, KeyError) as e:
        raise SystemExit(f"{op}-mode: {e}")
    Archive(body=encrypt_body(new), banner=arc.banner).save(dst)
    c = Codeplug.parse(decrypt_body(Archive.load(dst).body))
    key = lambda m: (m.rx_mhz, m.tx_mhz, m.ta_mhz, m.name, m.rx_pl, m.tx_pl, m.ta_pl)
    old = [key(m) for m in a.modes]
    if op == "add":
        want = old[:after] + [None] + old[after:]
        got = [key(m) for m in c.modes]
        ok = len(got) == len(want) and all(w is None or w == g for w, g in zip(want, got))
        print(f"wrote {dst}: mode {after + 1} added ({c.modes[after].name!r}, "
              f"{c.modes[after].rx_mhz} MHz), {len(c.modes)} modes; "
              f"verify (other modes unchanged): {'OK' if ok else 'FAIL'}")
    else:
        want = old[:after - 1] + old[after:]
        ok = [key(m) for m in c.modes] == want
        print(f"wrote {dst}: mode {after} ({a.modes[after - 1].name!r}) deleted, "
              f"{len(c.modes)} modes; verify (other modes unchanged): {'OK' if ok else 'FAIL'}")
    if c.zones:
        print("  zones:", "; ".join(f"{z.number} {z.name}: {len(z.modes)} modes" for z in c.zones))


def zone_op(src: str, dst: str, op: str, args: list[str]) -> None:
    arc = Archive.load(src)
    body = decrypt_body(arc.body)
    a = Codeplug.parse(body)
    try:
        num = int(args[0])
        if op == "add":
            kw = dict(x.split("=", 1) for x in args[1:])
            new = zonelist.add_zone(body, num, [int(m) for m in kw.get("modes", "").split(",") if m],
                                    name=kw.get("name"))
        else:
            new = zonelist.delete_zone(body, num)
    except (ValueError, KeyError) as e:
        raise SystemExit(f"{op}-zone: {e}")
    Archive(body=encrypt_body(new), banner=arc.banner).save(dst)
    c = Codeplug.parse(decrypt_body(Archive.load(dst).body))
    old = [(z.name, z.modes) for z in a.zones]
    got = [(z.name, z.modes) for z in c.zones]
    key = lambda m: (m.rx_mhz, m.tx_mhz, m.ta_mhz, m.name, m.rx_pl, m.tx_pl, m.ta_pl)
    same_modes = [key(m) for m in a.modes] == [key(m) for m in c.modes]
    if op == "add":
        ok = got[:num - 1] + got[num:] == old and same_modes
        what = f"zone {num} added ({c.zones[num - 1].name!r}, modes {c.zones[num - 1].modes})"
    else:
        ok = got == old[:num - 1] + old[num:] and same_modes
        what = f"zone {num} ({a.zones[num - 1].name!r}) deleted"
    print(f"wrote {dst}: {what}, {len(c.zones)} zones, home zone {c.body[0x1DD]}; "
          f"verify (other zones + modes unchanged): {'OK' if ok else 'FAIL'}")
    print("  zones:", "; ".join(f"{z.number} {z.name}: {len(z.modes)} modes" for z in c.zones))


def read_radio(port: str, outdir: str) -> None:
    import json

    from .crypto import encrypt_body
    from .radio import Radio, SerialLink

    os.makedirs(outdir, exist_ok=True)
    logf = open(os.path.join(outdir, "radio.log"), "w")
    link = SerialLink(port, log=lambda line: logf.write(line + "\n"))

    def progress(done, total):
        print(f"\r  codeplug {done:#06x} / {total:#06x}", end="", flush=True)

    radio = None
    try:
        radio = Radio(link, progress)
        res = radio.read_all()
    finally:
        if radio is not None:
            radio.finish()          # never leave the radio's panel frozen
        link.close()
        logf.close()
    print()
    cp = res.codeplug
    serial = cp[0x1D:0x27].decode("latin-1")
    with open(os.path.join(outdir, "codeplug.bin"), "wb") as f:
        f.write(cp)
    with open(os.path.join(outdir, "mcu.json"), "w") as f:
        json.dump({f"{a:04x}": v.hex() for a, v in res.mcu.items()}, f, indent=1)
    name = f"A{serial[:7]}.{serial[7:]}"
    Archive(encrypt_body(res.archive_body())).save(os.path.join(outdir, name))
    print(f"read {len(cp):#x} bytes from radio {serial}; wrote {outdir}/{name}, "
          f"codeplug.bin, mcu.json, radio.log")


def dump_radio(port: str, outdir: str, which: str = "both",
               registers: bool = False) -> None:
    import json
    import time

    from .radio import HC11_REGISTERS, SESSION_CODEPLUG, SESSION_MCU, Radio, SerialLink

    os.makedirs(outdir, exist_ok=True)
    logf = open(os.path.join(outdir, "radio.log"), "w")
    link = SerialLink(port, log=lambda line: logf.write(line + "\n"))
    sessions = {"codeplug": SESSION_CODEPLUG, "mcu": SESSION_MCU}
    names = list(sessions) if which == "both" else [which]
    skip = () if registers else (HC11_REGISTERS,)
    result = {}
    t0 = time.monotonic()

    def progress(done, total):
        print(f"\r  {done:#07x} / {total:#07x}  {time.monotonic() - t0:5.0f} s",
              end="", flush=True)

    radio = None
    try:
        radio = Radio(link)
        for name in names:
            print(f"{name} session:")
            mem, ok, bad = radio.dump(sessions[name], skip=skip, progress=progress)
            print()
            with open(os.path.join(outdir, f"{name}_space.bin"), "wb") as f:
                f.write(mem)
            result[name] = {"readable": [f"{a:04x}" for a in ok],
                            "no_answer": [f"{a:04x}" for a in bad],
                            "skipped": [f"{lo:04x}-{hi - 1:04x}" for lo, hi in skip]}
            print(f"  {len(ok)} blocks read, {len(bad)} unanswered")
        radio.mode(0x10, 0x01)
    finally:
        if radio is not None:
            radio.finish()          # never leave the radio's panel frozen
        link.close()
        logf.close()
    with open(os.path.join(outdir, "dump_map.json"), "w") as f:
        json.dump(result, f, indent=1)
    write_dump_parts(outdir)


def write_dump_parts(outdir: str) -> None:
    """Split <outdir>/*_space.bin into named region files + README.txt.
    Prefers the codeplug-session dump (it answers every block), filling gaps
    from the MCU session."""
    from .radio import split_dump

    spaces = [os.path.join(outdir, f"{n}_space.bin") for n in ("codeplug", "mcu")]
    spaces = [open(p, "rb").read() for p in spaces if os.path.exists(p)]
    if not spaces:
        return
    space = bytearray(spaces[0])
    for other in spaces[1:]:          # fill blocks the first session didn't give
        for a in range(0, 0x10000, 0x100):
            if space[a:a + 0x100] == b"\xff" * 0x100:
                space[a:a + 0x100] = other[a:a + 0x100]
    lines = ["Spectra memory dump (motreader dump-radio). Contains Motorola",
             "firmware: keep it private.", ""]
    for name, start, data, desc in split_dump(bytes(space)):
        with open(os.path.join(outdir, name), "wb") as f:
            f.write(data)
        lines.append(f"{name:22} {start:#06x}-{start + len(data) - 1:#06x}  {desc}")
    lines += ["", "*_space.bin: each session's whole 64 KB (0xFF where not read);",
              "dump_map.json: which blocks answered. 0x1000-0x10FF is skipped",
              "unless --registers (68HC11 registers)."]
    with open(os.path.join(outdir, "README.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines[3:3 + len(split_dump(bytes(space)))]))


def write_radio(port: str, archive: str, outdir: str, clone=False,
                ignore_features=False) -> None:
    from .crypto import decrypt_body
    from .radio import Radio, SerialLink

    body = decrypt_body(Archive.load(archive).body)
    image, options = body[0xAD:], body[13:19]
    os.makedirs(outdir, exist_ok=True)
    logf = open(os.path.join(outdir, "radio.log"), "w")
    link = SerialLink(port, log=lambda line: logf.write(line + "\n"))

    def progress(done, total):
        print(f"\r  {done:#06x} / {total:#06x}", end="", flush=True)

    radio = None
    try:
        radio = Radio(link, progress)
        print("backup read:")
        before = radio.read_all(finish=False)
        print()
        _save_read(before, os.path.join(outdir, "backup"))
        changed = sum(a != b for a, b in zip(before.codeplug, image))
        print(f"programming {len(image):#x} bytes ({changed} differ from the radio):")
        after = radio.program_verified(image, progress, clone=clone,
                                       options=options,
                                       ignore_features=ignore_features)
        print()
        _save_read(after, os.path.join(outdir, "after"))
    finally:
        if radio is not None:
            radio.finish()          # never leave the radio's panel frozen
        link.close()
        logf.close()
    print(f"programmed and verified; backup in {outdir}/backup")


def _save_read(res, outdir: str) -> None:
    import json

    from .crypto import encrypt_body

    os.makedirs(outdir, exist_ok=True)
    cp = res.codeplug
    serial = cp[0x1D:0x27].decode("latin-1")
    with open(os.path.join(outdir, "codeplug.bin"), "wb") as f:
        f.write(cp)
    with open(os.path.join(outdir, "mcu.json"), "w") as f:
        json.dump({f"{a:04x}": v.hex() for a, v in res.mcu.items()}, f, indent=1)
    Archive(encrypt_body(res.archive_body())).save(
        os.path.join(outdir, f"A{serial[:7]}.{serial[7:]}"))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "export" and len(argv) == 4:
        export(argv[2], argv[3])
    elif cmd == "import" and len(argv) == 5:
        do_import(argv[2], argv[3], argv[4])
    elif cmd == "decode" and len(argv) in (3, 4):
        decode(argv[2], argv[3] if len(argv) == 4 else None)
    elif cmd == "add-mode" and len(argv) >= 5:
        mode_op(argv[2], argv[3], "add", argv[4:])
    elif cmd == "delete-mode" and len(argv) == 5:
        mode_op(argv[2], argv[3], "delete", argv[4:])
    elif cmd == "add-zone" and len(argv) >= 6:
        zone_op(argv[2], argv[3], "add", argv[4:])
    elif cmd == "delete-zone" and len(argv) == 5:
        zone_op(argv[2], argv[3], "delete", argv[4:])
    elif cmd == "remove-trunking" and len(argv) == 4:
        remove_trunking(argv[2], argv[3])
    elif cmd == "read-radio" and len(argv) == 4:
        read_radio(argv[2], argv[3])
    elif (cmd == "dump-radio" and len(argv) >= 4
          and set(argv[4:]) <= {"codeplug", "mcu", "both", "--registers"}):
        which = next((x for x in argv[4:] if x != "--registers"), "both")
        dump_radio(argv[2], argv[3], which, "--registers" in argv[4:])
    elif (cmd == "write-radio" and len(argv) >= 6 and "--yes" in argv[5:]
          and set(argv[5:]) <= {"--yes", "--clone", "--ignore-features"}):
        write_radio(argv[2], argv[3], argv[4], clone="--clone" in argv[5:],
                    ignore_features="--ignore-features" in argv[5:])
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
