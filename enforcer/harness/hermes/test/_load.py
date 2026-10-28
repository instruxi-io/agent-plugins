"""Load the plugin directory as a package (`enforcer_hermes`) so its relative
imports resolve the way Hermes resolves them, whatever the checkout is named."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def plugin():
    if "enforcer_hermes" in sys.modules:
        return sys.modules["enforcer_hermes"]
    spec = importlib.util.spec_from_file_location(
        "enforcer_hermes", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["enforcer_hermes"] = mod
    spec.loader.exec_module(mod)
    return mod
