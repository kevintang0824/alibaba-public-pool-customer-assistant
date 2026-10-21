from __future__ import annotations


class AssistantError(RuntimeError):
    pass


class DependencyMissing(AssistantError):
    pass


class NeedManualIntervention(AssistantError):
    def __init__(self, reason: str, *, screenshot_path: str | None = None):
        super().__init__(reason)
        self.reason = reason
        self.screenshot_path = screenshot_path


class AutomationStepFailed(AssistantError):
    def __init__(self, action: str, reason: str, *, screenshot_path: str | None = None):
        super().__init__(f"{action}: {reason}")
        self.action = action
        self.reason = reason
        self.screenshot_path = screenshot_path
