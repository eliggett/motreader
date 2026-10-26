# RSS validation rules and side effects (for the future UI)

motreader's import is a deliberately thin template-patch: it writes what the
CSV/YAML says and checks only encodability (ranges, character sets, field
widths). The rules below are what RSS itself enforces or does as a side effect
when a value changes. They were observed while mapping fields with the
dosbox-x harness. A UI should implement them; motreader does not (unless
noted).

Legend: **[blocks]** RSS refuses to leave/save the screen; **[warns]** RSS shows
a warning but accepts; **[side effect]** RSS changes other data too;
**[structural]** the change resizes/moves codeplug sections (read-only in
motreader).

## Radio-wide (radio.yaml `radio_wide`)

| Field(s) | Rule | Kind |
|---|---|---|
| `home_zone`, `home_mode` | The home mode must be a member of the home zone; otherwise F10 is "Key Not Defined" and the screen can't be left. A codeplug that arrives with the home mode outside the home zone (GET of a motreader edit) loads without a warning, but RSS's SAVE moves the home mode to the zone's first mode (617ASQ, 2026-10-24). | blocks / side effect |
| `master_adaptive_splatter`, `master_audio_compandor`, `time_out_timer` | Toggling the master asks "apply to all modes" (F2 CONTINUE) and rewrites the matching per-mode bit in every mode record. motreader flips only the master. | side effect |
| `mode_names` | Disabling resets every mode name to `MODE n` (also via the confirm dialog). motreader flips only the bit (and its mirror at 0x10B b7). | side effect |
| `mdc_signalling` | Toggling also rewrites per-mode MDC bits. Read-only in motreader. | side effect |
| Zone Operation (not exported) | Disabling shows "Disabling zone mode will clear all zone lists" (F2/F10) and clears them. | side effect |
| `control_head_type` | Standard / Enhanced / Rotary only; **S9000e can't be changed to or from** (owner; RSS offers no tab stop on 221AZN). Every swap shows "All names will be modified" (F2/F10). Rotary: Volume Set Tone "Not Avail", Phone/DTMF Encode forced to List, Mode Change Tone becomes "Zone Mode Change Tone" (off without zones). Enhanced/Rotary reset the CONTROL HEAD OPTIONS to defaults; the Standard head has no options screen. motreader reproduces all of this. | side effect |
| `siren_pa_options` | Set via F4 → F2 → F9 → TAB×12 (UP/DOWN: Disabled / PA only / Siren/PA). The SIREN/PA sub-screen (F6) opens only when it isn't Disabled ("Neither Siren or PA selected"). PA only shows only the PUBLIC ADDRESS settings; the SIREN settings need Siren/PA. motreader writes it, recomputing the control-head summary word. | blocks |
| `internal_pa`, `speaker_a_b` | "Not Avail" on 604AUN regardless of the siren (a model property); Disabled/Enabled on the other radios, including with Siren/PA on (617ASN). | n/a |
| Vehicle Repeater (not exported) | Deliberately unsupported (owner), like SECURENET and trunking: preserved verbatim from the template. | n/a |
| `horn_lights_rearm`, `internal_pa`, `speaker_a_b`, `siren_pa_options` | Change the control-head summary word CHB+0x1C/+0x1D (a checksum of CHB +0x12..+0x1A); motreader recomputes it. | side effect |
| ADDITIONAL OPTIONS (`tx_mic_input_control`, `filtered_audio_thru_rear`, `mic_gain`) | Offered only on some models ("This Option is Disabled" on 5 of 6 radios; 604AUN has it). | n/a |
| Speaker B VIP Number 3 | "VIP 3 can only be used with a Remote Mount Control Head." (F2 CONTINUE) | warns |
| Phone/DTMF Encode | Not editable on the on-hand models ("Not A Valid Entry"). | n/a |
| SYSTEM S & L | "Not Available For This Model" except 604ATY. | n/a |
| `max_user_modes`, `number_of_mpl`, Number of Single Tone / RAC | Resize tables; header directory bytes 0xDE-0xEF move. Read-only. | structural |
| `master_adaptive_splatter`, `master_audio_compandor` | 900 MHz only (VHF shows "Not Avail"); not exported for VHF. | n/a |
| ranges | Taken from the RSS labels: `minimum_volume`/`speaker_b_min_volume` 0-15, `mdc_unit_id` 0000-9999, `mdc_group_id` 00-99, `mdc_fleet_id` 0-9; `mdc_channel_busy_wait_s` Infinite or 0.5 s steps; timer fields in 5 ms (DTMF/phone) or 100 ms (MDC system delay) steps. RSS steps these with UP/DOWN and shows "MINIMUM"/"MAXIMUM" at the ends. The exact per-field limits are not yet recorded. | blocks |
| `phone_access_code` | Blank: "Blank Access Code Is Not Recommended" (F2 CONTINUE). | warns |
| `phone_access_code`, `phone_release_code` | 1-5 of `0-9 * #` ("P" is "Not A Valid Entry"). | blocks |
| `scan_tx_revert_mode` | Offered only with Scan Off HUB Disabled ("Not Avail" otherwise; not exported then). | n/a |
| `scan_dynamic_priority_assignment` | "Not Avail" on 566AYA, 604AUN, 617ASN (exported anyway; the bit is kept). | n/a |
| `scan_conv_rx_hang_time_ms`, `scan_conv_tx_hang_time_ms` | 250 ms steps (RSS shows seconds, 0.25 steps). | blocks |
| `conventional_scan.non_priority_list` / `priority_list` / `scan_type` (zones off) | Changing Op Select ↔ Mode Slave or Pri Tlkgr ↔ Talkgroup re-packs every mode record (+2+W bytes per Mode Slave record). motreader does it on import (re-export before editing the lists). | structural |

## Whole codeplug

- Older format versions 112 and 114 open "modes only": the web app edits their
  modes (fields, names) and nothing else; zones, radio-wide settings and lists
  aren't decoded and stay exactly as they are. Versions 101/102 are read-only.

| Rule | Kind |
|---|---|
| SAVE is refused with "Codeplug Has Exceeded Radio Memory By N Bytes. Modes And/Or Features Must Be Disabled" when a structural change outgrows the radio (604ATY, 128 modes: SCAN TYPE → Talkgroup was over by 1939 bytes). A UI that adds modes/features needs the radio's memory size. | blocks |
| A9 head: RSS warns "Bad control head checksum." on GET if the ASCII name block changes without its checksum. motreader keeps it valid. | warns |

## Names (modes, zones)

| Rule | Kind |
|---|---|
| Owner's rule for the web app: A-Z, 0-9, space and `- + / = # * \` ) ( @ $ % \ _`; no periods; lower case is turned into upper case as it is typed. Standard heads (6-bit names, characters 0x20-0x5F) can't hold the backtick; the A9 head's ASCII names can. 8 characters (A9: 11). | refused by the web app |
| Zone names on a codeplug whose zones are found by the structural search (no RSS zone pointers) must also start with a letter or digit and use only letters, digits, space, / and -, or the search won't find them again. | refused by the web app |

## Modes (modes.csv) — frequencies

| Rule | Kind |
|---|---|
| RSS refuses a frequency outside the model's range ("Value Outside Range For This Model": 617ASQ takes 144 MHz and up). The owner's rule for the UI: don't validate frequencies, write whatever can be encoded. | blocks (RSS) |
| VHF TX/TA: above 165.74 MHz some frequencies have no byte encoding (the synthesizer's 8-bit count would overflow; FORMAT §5a). RSS accepts them and **stores a wrong (wrapped) frequency** (165.75 → 84.47 MHz). motreader and the web app refuse them, naming the nearest storable value; 165.0, 170.25, 171.0 are fine. | refused by motreader |
| VHF RX: on a 5 kHz or 6.25 kHz raster (RSS refuses the rest; 146.5225 isn't on either); the web app refuses them. RSS's RX range is per model: the v112/v114 AR-ORIG radios and 617ASQ refused 136–140 MHz. | refused by the web app |
| VHF TX/TA: on a 2.5 kHz raster. Other values are stored as the nearest the field holds (the web app says so). | n/a |
| Some VHF models show Transmit Power / Talkaround Power (and on one, MPL Type) as "Not Avail" in RSS: the bits are still in the record but do nothing there. The web app doesn't know which models; a UI could hide them. | n/a |
| 800 MHz: decoded only; such codeplugs open read-only. | read-only |
| UHF: frequencies on a 6.25 or 5 kHz raster only (RSS refuses most others); the web app refuses them. | refused by the web app |
| UHF: RSS forces Tx/T·A power Low above 470 MHz; the encoder does the same and the web app refuses High there. | side effect / refused |
| UHF and VHF: entering some Rx frequencies makes RSS change uP Xtal Shift ("Crystal Frequency Will Be Shifted", F2 to continue). The web app keeps it as a setting; a UI could warn. | side effect (RSS) |
| 900 MHz: 12.5 kHz raster; motreader reads 895–942 MHz as a 900 MHz frequency, so values outside it are refused. Adding T/A to a simplex 900 mode isn't supported yet (clearing T/A to make a mode simplex is). | refused by motreader |

## Modes (modes.csv) — squelch codes

| Rule | Kind |
|---|---|
| Rx, Tx and T·A codes are independent (`rx_pl`/`tx_pl`/`ta_pl` + `*_squelch_type`): a PL tone ("141.3"), a DPL code ("D411") with type DPL or INV.DPL, or Carrier = empty code with type Carrier. An empty code with type PL/DPL is left as it is (protects tones motreader can't name). | n/a |
| The T·A code matters only when Talkaround is enabled (RSS hides it otherwise). | n/a |
| Simplex modes (Tx = Rx) and T·A: older RSS versions allowed a T·A frequency/code on a simplex mode; our RSS (R06.00.05) refuses a T·A setting when the mode is already simplex. Likely a UI guard against confusion rather than a radio limit (owner's experience). motreader preserves whatever the codeplug holds; a GUI can follow RSS (hide T·A on simplex) or allow it with a note. | guard (RSS) |
| Re-export before editing: modes.csv files from before 2026-10-24 mirrored the 900 Rx code into tx_pl. | note |
| RSS shows a few Tx tones by their stored period (203.5 as "203.4", 218.1 as "218.2"); same bytes. | n/a |

## Adding / deleting modes (motreader add-mode / delete-mode)

| Rule | Kind |
|---|---|
| Modes renumber: inserting after N shifts N+1.. up by one; deleting N shifts later modes down (zones, priority modes, home mode follow). A GUI should present modes as an ordered list. | n/a |
| Zone Operation on: a new mode must be put in a zone (RSS won't save a mode outside every zone). | blocks |
| Deleting a zone's only mode would empty the zone (RSS drops empty zones): refused. | blocks |
| Deleting the home mode: refused (change the home mode first; RSS's behavior not captured). | blocks |
| At most header 0x1D5 modes (128 on the on-hand radios; the "99 mode limit" fix in the repeater-builder article raises this byte). | blocks |
| RSS ADD writes a model default mode ("MODE  nn", band-edge frequency); motreader copies an existing mode instead (default: the one it's inserted after) and the new mode's own zones-off scan list starts empty (as RSS's). | n/a |
| Name length: 8 characters on standard heads, 11 on the A9 head (motreader refuses longer). | blocks |
| A9 head: direct-entry "Mode N" buttons keep their number when modes renumber (RSS does the same), so they then select a different mode. A GUI should warn and offer to update them. | n/a |
| A9 head: RSS's default name is "  MODE   66" (leading spaces kept and shown by RSS). A GUI may prefer offering a plain default. | n/a |
| Zones-off scan lists are renumbered. RSS gets this wrong: ADD leaves the member numbered after+1 as is (the new mode inherits its list places, the old one drops out); DELETE on 900 Mode Slave lists shifts later members by two. motreader renumbers correctly. | differs (deliberate) |
| Not handled yet (refused): trunked codeplugs (remove trunking first), width changes above 120 modes. | blocks |
| Web app: Add mode asks for the position, the mode to copy, the name (checked like a rename) and, with zones on, the zones (defaulting to the copied mode's); Duplicate copies the active mode right after it, same name and zones; Delete asks first. Each re-packs the codeplug, highlighting of earlier edits restarts, and Undo (one step per change) puts the codeplug back, dropping edits made after the change (asked first). | n/a |
| Older format versions (112 / 114): no add / delete yet. | refused by the web app |

## Zones (radio.yaml `zones`)

| Rule | Kind |
|---|---|
| A zone with no modes is deleted by RSS on save. motreader refuses an empty `modes` list. | side effect |

### Adding / deleting zones (motreader add-zone / delete-zone)

| Rule | Kind |
|---|---|
| Zones renumber: a zone inserted at position P becomes P and later zones move up; deleting zone N moves later zones down. | n/a |
| A new zone needs at least one mode (RSS drops an empty zone when it saves, so an RSS ADD ZONE without marking modes in its ZONE MODE LIST does nothing). motreader refuses an empty zone. | blocks |
| Deleting a zone must leave every mode in some zone (RSS: "mode # N is not assigned to any zone. Archive will not be packed"). motreader refuses and names the modes. | blocks |
| Home zone, RSS: ADD leaves the number alone (it can end up pointing at another zone, and RSS then won't pack if the home mode isn't in it). DELETE of a zone at or before the home zone sets home zone 01, and when packing RSS resets the home mode to that zone's first mode (566AYA: 12/120 became 01/2). motreader instead renumbers the home zone so it keeps pointing at the same zone, and refuses to delete the home zone (change it first). | differs (deliberate) |
| A9 head: direct-entry "Zone N" buttons keep their number when zones renumber (RSS does the same). A GUI should warn. | n/a |
| Name: 8 characters on standard heads, 11 on the A9; RSS default "ZONE  nn". | blocks |
| Zone count limit: not pinned down. The A9 string area has room for 28 more 11-char names on 221AZN (12 zones + 250 mode slots + 28 spare: probably 40 zones max); motreader refuses when that area is full. | blocks |
| Not handled (refused): Zone Operation off, trunked codeplugs. | blocks |

### Zone scan lists (radio.yaml `zones[].scan`)

| Rule | Kind |
|---|---|
| At most **16 members**, `<SELMOD>` included ("List = nn of 16 Max"); RSS won't add a 17th. motreader refuses. | blocks |
| `<SELMOD>` (the selected mode) is always a member; it is N Pri unless it is Priority 1 or 2. It can't be removed. | n/a |
| Only one Priority 1 and one Priority 2 per list, and not the same mode (RSS skips a taken priority when cycling). motreader refuses. | blocks |
| Priority modes need SCAN TYPE Pri Tlkgr. RSS drops both when the type becomes Talkgroup (they don't become N Pri members). motreader refuses priorities with Talkgroup; with Disabled they are kept, as RSS does. | blocks |
| SCAN TYPE Disabled: RSS keeps the list but won't open it ("SCAN IS DISABLED ON THIS ZONE / CANNOT EDIT SCAN LIST"). | n/a |
| SCAN TYPE choices are model-specific (617ASN: Talkgroup / Disabled / Pri Tlkgr; 604AUN: Pri Tlkgr / Disabled; 566AYA: Talkgroup / Disabled). motreader accepts any of the three; a GUI should offer RSS's list. | n/a |
| Priority List is shown only with Pri Tlkgr; Non-Priority List not with Disabled. | n/a |
| A list may include modes outside its zone. | n/a |
| A mode listed as priority and also in `modes` is stored as priority only. | n/a |

### Zones-off scan (modes.csv scan columns, radio.yaml `conventional_scan`)

| Rule | Kind |
|---|---|
| SCAN TYPE follows the modes: Disabled while no mode scans (not a tab stop then), else Pri Tlkgr / Talkgroup (900) or Channel (VHF). RSS lets you change it only on some models (604ATY: Pri Tlkgr ↔ Talkgroup; 617ASQ fixed Channel). motreader: Pri Tlkgr ↔ Talkgroup on 900 radios with a scanning mode; else refused. | blocks |
| Talkgroup keeps the Priority List Mode Slave (RSS hides the choice); Talkgroup → Pri Tlkgr warns "Non_Priority Scan List(S) Will Be Cleared Out" (F2/F10). motreader refuses that direction when the Non-Priority lists are Mode Slave (the clearing isn't reproduced yet). | blocks |
| Talkback Scan Enabled warns "For Proper Talkback Scan Operation, The RX and TX Hang Time Delay Values Are Recommended To Be a Minimum of Four Seconds" (F2). | warns |
| A mode's list can be viewed only with its SCAN Enabled ("SCAN Not Enabled."). | n/a |
| Max members: min(16, modes + 1 with `<SELMOD>`). `<SELMOD>` exists only with Priority List Op Select. motreader refuses more. | blocks |
| One Priority 1 and one Priority 2, not the same mode. motreader refuses. | blocks |
| Non-Priority Mode Slave: a mode is always on its own list ("The Selected Mode May Not Be Deleted From the List"); RSS adds it whenever it shows the list. motreader adds it when it writes that mode's list. | side effect |
| Op Select ↔ Mode Slave: a list turning Mode Slave starts as a copy of the radio-wide list in every mode; turning Op Select it keeps mode 1's. | side effect |
| The memory limit: per-mode lists cost 2+W bytes per mode; 604ATY (128 modes) can't take them ("Codeplug Has Exceeded Radio Memory By 1939 Bytes"). motreader refuses Mode Slave above 120 modes. | blocks |

### Zone Operation

| Rule | Kind |
|---|---|
| Turning ZONE OPERATION off: "Disabling zone mode will clear all zone lists" (F2 CONTINUE / F10 ABORT). All zones and per-zone scan lists are lost; home zone becomes 0. | confirm |
| Turning it on: RSS won't leave RADIO-WIDE ("The selected Home mode is not in the Home zone. It will be defaulted when the codeplug is packed") until zones exist, and won't SAVE until **every mode is in at least one zone** ("mode # N is not assigned to any zone. Archive will not be packed"). | blocks |
| With zones on, a zone membership edit must leave every mode in some zone (same SAVE rule). | blocks |
| motreader: a `zone_operation` change re-packs on import (standard-head conventional radios, up to 120 modes); zones-on creates "ZONE  01" with every mode and home zone 1. zones / home_zone from the same radio.yaml are not applied in that import (re-export, then edit). Refused: A9 head, trunked codeplugs, > 120 modes. | n/a |

### Trunking (TRUNKED DUAL MODE)

| Rule | Kind |
|---|---|
| RSS won't delete the last trunked mode (each system needs one, in a zone); MAX SYSTEMS / SUBFLEETS / CONV MODES aren't editable on B5 models; trunking edits need a system key file (repeater-builder article). | blocks (RSS) |
| `motreader remove-trunking` converts the trunked mode 1 into a conventional copy of mode 2: re-export and edit mode 1 afterwards (name, frequencies, tones). Zones that held the trunked mode now hold that conventional mode. | n/a |
| After programming, the radio may report ER 01/02 or 01/82 once (article, for the RSS method); reading the radio and writing it back clears it. | note |

## Phone list (phones.csv)

| Rule | Kind |
|---|---|
| Number: up to 16 of `0-9 * # P` (P = pause); letters A-D are "Not A Valid Entry". | blocks |
| Name: 8 chars (11 on A9/expanded heads). Some punctuation is rejected ("A-/.&#*Z" was refused; the exact allowed set is not yet pinned down). | blocks |
| On some models the list is "PHONE Is Disabled" (e.g. 566AYA, which still stores a populated list). The list is shared by conventional and trunked interconnect. | n/a |

## MPL list (mpl.csv)

| Rule | Kind |
|---|---|
| Exists only when Number of MPL > 0. motreader cannot add rows (structural). | structural |
| Squelch type per slot: Carrier / TPL / DPL / INV.DPL (RSS cycles them with UP/DOWN). Choosing TPL/DPL leaves the code "Blank" (stored as Carrier, 0000) until a code is entered. | n/a |
| Name: 8 chars (6-bit) on standard heads, 11 ASCII on A9. | blocks |
| A TPL code that isn't a standard tone is shown with code `--` (e.g. 186.3). RSS accepts it as stored. | n/a |

## Control-head buttons (buttons.csv)

| Rule | Kind |
|---|---|
| A function can be on only one button: leaving the KEYPAD screen with a duplicate shows "Duplicate Buttons! Press F2 To Blank The Other Button" (F10 abort). motreader refuses duplicates (Blank is exempt). | blocks |
| Ind 5 ("Sel"), `*` (Rcl) and `#` (Del) are fixed: no tab stop. | blocks |
| The functions offered depend on the button and the enabled features. 566AYA keypad keys 1-9/0 offered only Blank, Phone, ZnDN, ZnUP, Page, MPL, Dir, Mon, Call, H/L. 604AUN Ind 1 offered 28, incl. Rpg, Msg, Sts, Lck, Ste, VRS, PA, the siren set (Siren, Wail, Yelp, HiLo, Airhn, Man, XRadA, XRadB, needing Siren/PA), Emer, Scan, Bid. motreader accepts any known function, so a GUI should offer RSS's lists. | n/a |
| Radios with 0x10D b1 set (no full keypad: 617ASN, 617ASQ) have only Ind 1-5 and keys 7/8/9. | n/a |

### A9 / S9000e head (221AZN, buttons_a9.py)

| Rule | Kind |
|---|---|
| Fixed: `*` RCL, `0` Sql, `#` Del ("May NOT Be Changed"); **Ind 1 must stay Sel** and the **Home key must stay Home** ("SEL / HOME Button Is REQUIRED For Proper Control Head Operation", even with Sel/Home put on another key too). motreader refuses edits to them. | blocks |
| Duplicate check covers **only Ind 1-6 and keys 1-9**: the labelled keys (Mode Dn/Up, Vol Dn/Up, Zone Up) may repeat a function that is elsewhere (Scan on Vol Up with Scan on Ind 4 is accepted). On a duplicate, RSS's F2 blanks **whichever of the two buttons is later in TAB order** (Ind 1-6, 1-9, Mode Dn ... Home), not necessarily the one just edited. motreader refuses duplicates in that scope. | blocks |
| RSS's duplicate check is by **label**: byte-identical aliases (Send-A next to Sel) are accepted. | n/a |
| **Direct-entry functions** need a number: Zone X (≤ number of zones), Mode X, Sts X (≤ 8: 12 is refused), Msg X. RSS: select it, Enter, type the number, Enter; leaving without one shows "DATA must be entered for direct entry buttons". In buttons.csv write e.g. `Zone 4`, `Sts 3`. | blocks |
| Offered functions per key class (RSS's DOWN-arrow lists, in `motreader/_a9_table.ALLOWED`): Ind 2-6 = 50 incl. siren set, Emer, Scan, Phone, Data, Pass/Emp No; keypad keys 1-9 = 33 (no Scan/Emer/siren-on/PA, but Zone Up/Dn, MAck); labelled keys = 50 incl. Mode/Vol/Zone/Scroll, Del/RCL/Sql/Clr/Sel/Home. motreader refuses functions not offered on that key. SECURENET appears in the lists but is never offered by motreader (encryption is not exposed). | blocks |
| **Byte-identical pairs**: Vol Dn = V/A Dn, Vol Up = V/A Up, Mode Dn = Scrl-Lt, Mode Up = Scrl-Rt, Sel = Send-A, Emp No = Pass. A saved codeplug can't tell them apart; RSS shows the first name after GET, so motreader exports that name and accepts either on import. A GUI should present them as one choice (or note the alias). | n/a |
| Copy 2 of the key map is the trunking layer: some functions write Blank there (Dir, StsR, MsgR, ST, MPL, M/WT, MAck, Sql) or a trunked variant (Phone, Call-A/B, Page-A, Sts, Msg). Handled by the templates; nothing for a GUI to do. | n/a |
