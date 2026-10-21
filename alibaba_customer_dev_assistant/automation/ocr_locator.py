from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from alibaba_customer_dev_assistant.core.errors import AutomationStepFailed


@dataclass(frozen=True)
class OcrMatch:
    text: str
    confidence: float
    x: int
    y: int


class OcrLocator:
    def __init__(self):
        from paddleocr import PaddleOCR

        self.ocr = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)

    def find_text(self, image_path: Path, keywords: tuple[str, ...], min_confidence: float = 0.5) -> OcrMatch:
        result = self.ocr.ocr(str(image_path), cls=True)
        matches: list[OcrMatch] = []
        for page in result or []:
            for line in page or []:
                box, payload = line
                text, confidence = payload
                if confidence < min_confidence:
                    continue
                if not any(keyword in text for keyword in keywords):
                    continue
                xs = [int(point[0]) for point in box]
                ys = [int(point[1]) for point in box]
                matches.append(
                    OcrMatch(
                        text=text,
                        confidence=float(confidence),
                        x=int(sum(xs) / len(xs)),
                        y=int(sum(ys) / len(ys)),
                    )
                )
        if not matches:
            raise AutomationStepFailed("ocr_find_text", f"OCR未找到文字：{', '.join(keywords)}")
        return sorted(matches, key=lambda item: item.confidence, reverse=True)[0]
