from __future__ import annotations

import importlib.util
from dataclasses import dataclass


REQUIRED_AUTOMATION_MODULES = ("uiautomation", "pywinauto")
OPTIONAL_OCR_MODULES = ("cv2", "paddleocr", "PIL")


@dataclass(frozen=True)
class DependencyReport:
    modules: dict[str, bool]

    @property
    def automation_ready(self) -> bool:
        return all(self.modules.get(module, False) for module in REQUIRED_AUTOMATION_MODULES)

    @property
    def ocr_ready(self) -> bool:
        return all(self.modules.get(module, False) for module in OPTIONAL_OCR_MODULES)

    @property
    def missing(self) -> list[str]:
        return [module for module, installed in self.modules.items() if not installed]


def check_dependencies() -> DependencyReport:
    module_names = (*REQUIRED_AUTOMATION_MODULES, *OPTIONAL_OCR_MODULES)
    return DependencyReport(
        modules={name: importlib.util.find_spec(name) is not None for name in module_names}
    )
