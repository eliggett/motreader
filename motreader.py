"""The Python library lives in motreader-py/, which isn't an importable name.
This module stands in for the package: with the repo root on sys.path,
`import motreader.codeplug` and `python -m motreader.cli` load the modules
in motreader-py/ (a module with __path__ is treated as a package)."""

import os

__path__ = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "motreader-py")]
