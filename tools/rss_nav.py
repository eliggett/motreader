"""Robust, screen-verified RSS navigation helpers operating on a dbxctl.Dbx
connected to an already-running harness dosbox-x. Shared by field_diff.py and
the mapping scenarios. Waits are generous (RSS boot + disk I/O are slow) and
every step verifies the destination screen before proceeding.
"""
import time, shutil, os, glob


def resolve_afile(arch_dir):
    """The single radio's A-codeplug file in a sandbox ARCHIVE dir (RSS may
    change its case on save). Returns the newest matching non-B, non-DBF file."""
    cands = [f for f in glob.glob(os.path.join(arch_dir, "*"))
             if not os.path.basename(f).lower().endswith(".dbf")
             and not os.path.basename(f).lower().startswith("b")]
    if not cands:
        raise FileNotFoundError(f"no A-file in {arch_dir}")
    return max(cands, key=os.path.getmtime)


def scr(d):
    return "\n".join(d.read_screen()[0] or [])


def wait_for(d, sub, tries=80, interval=0.4):
    for _ in range(tries):
        if sub in scr(d):
            return True
        time.sleep(interval)
    return False


def key_to(d, key, sub, tries=80):
    """Press key (if any), then wait for sub to appear."""
    if key:
        d.send_keys(key)
    return wait_for(d, sub, tries=tries)


def to_main(d):
    for _ in range(10):
        s = scr(d)
        if "MAIN MENU" in s:
            return True
        # F10 from an edited sub-screen can raise a "modifications not saved"
        # (or similar) WARNING with an F2 CONTINUE prompt; clear it and retry.
        if "WARNING" in s or "not saved" in s or "Modifications" in s:
            d.send_keys("f2")
            time.sleep(0.5)
            continue
        d.send_keys("f10")
        time.sleep(0.8)
    return "MAIN MENU" in scr(d)


def boot_and_get(d):
    """From a freshly launched RSS (or one already booted): -> GET SELECTED."""
    # dismiss the splash if present; otherwise we may already be in RSS
    if wait_for(d, "Press Any Key", tries=40):
        d.send_keys("enter")
    if "MAIN MENU" not in scr(d):
        to_main(d)
    if not wait_for(d, "MAIN MENU", tries=120):
        raise RuntimeError("never reached MAIN MENU:\n" + scr(d))
    if not key_to(d, "f3", "GET / SAVE MENU"):
        raise RuntimeError("no GET/SAVE menu")
    d.send_keys("f3")
    if not wait_for(d, "RADIO SERIAL"):
        if "WARNING" in scr(d):
            d.send_keys("f2"); wait_for(d, "RADIO SERIAL")
        else:
            raise RuntimeError("no archive list:\n" + scr(d))
    d.send_keys("f8")                       # GET SELECTED
    if not wait_for(d, "GET / SAVE MENU"):
        # A stale checksum (e.g. "Bad control head checksum" after a motreader
        # edit) raises an F2 CONTINUE prompt during GET; dismiss it and go on.
        s = scr(d)
        if "Continue" in s or "checksum" in s or "WARNING" in s:
            d.send_keys("f2")
            wait_for(d, "GET / SAVE MENU")
        if "GET / SAVE MENU" not in scr(d):
            raise RuntimeError("GET did not return to menu:\n" + scr(d))
    # confirm a model loaded (header shows model number)
    if "Model:" not in scr(d):
        raise RuntimeError("no model after GET:\n" + scr(d))
    return True


def enter_screen(d, screen):
    to_main(d)
    if not key_to(d, "f4", "CHANGE / VIEW"):
        raise RuntimeError("no CHG/VIEW")
    if not key_to(d, "f5", "MODE CONFIGURATION"):
        raise RuntimeError("no MODE screen")
    if screen == "mode":
        return True
    if screen == "opt1":
        return key_to(d, "f7", "CONFIGURATION OPTIONS")
    if screen == "util":
        return key_to(d, "f8", "UTILITY")
    raise ValueError(screen)


SAVE_DIALOGS = []      # screens of any F2-CONTINUE dialogs met by save()


def save(d, arch_dir, dst):
    """SAVE the working codeplug to the archive file, copy it to dst.
    Robust against dropped keystrokes: retries F8 until the BACKUP prompt
    appears (that is when RSS has written the file), and verifies the archive
    file's mtime advanced before copying. Returns dst; raises on failure."""
    before = os.path.getmtime(resolve_afile(arch_dir))
    to_main(d)
    if not key_to(d, "f3", "GET / SAVE MENU"):
        raise RuntimeError("no GET/SAVE for save")
    d.send_keys("f7")
    for _ in range(8):                       # dialogs on the way (e.g. after a
        if wait_for(d, "SAVE CODEPLUG", tries=6):   # zone-operation change)
            break
        s = scr(d)
        if "Press F2" in s or "CONTINUE" in s:
            SAVE_DIALOGS.append(s)
            d.send_keys("f2")
            time.sleep(1.0)
    else:
        raise RuntimeError("no SAVE screen:\n" + scr(d))
    # Press F8 to write; the diskette BACKUP prompt confirms the write happened.
    got_backup = False
    for _ in range(4):
        d.send_keys("f8")
        if wait_for(d, "BACKUP", tries=20):
            got_backup = True
            break
    if not got_backup:
        raise RuntimeError("SAVE never reached BACKUP prompt:\n" + scr(d))
    d.send_keys("f10")                       # abort diskette backup (file already written)
    wait_for(d, "GET / SAVE MENU", tries=40)
    # verify the file actually changed on disk
    for _ in range(20):
        af = resolve_afile(arch_dir)
        if os.path.getmtime(af) > before:
            time.sleep(0.3)
            shutil.copy(af, dst)
            return dst
        time.sleep(0.3)
    raise RuntimeError("archive file mtime did not advance after save")
