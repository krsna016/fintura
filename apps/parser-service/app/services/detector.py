from typing import Optional
from app.parsers.base import BaseBankParser
from app.parsers.icici_parser import ICICIParser
from app.parsers.yes_bank_parser import YesBankParser
from app.parsers.idfc_first_parser import IDFCFirstParser
from app.parsers.hdfc_parser import HDFCParser
from app.parsers.axis_parser import AxisParser

class ParserRegistry:
    def __init__(self):
        self._parsers: list[BaseBankParser] = []
        # Auto-register supported bank parsers
        self.register(ICICIParser())
        self.register(YesBankParser())
        self.register(IDFCFirstParser())
        self.register(HDFCParser())
        self.register(AxisParser())

    def register(self, parser: BaseBankParser):
        self._parsers.append(parser)

    def detect(self, sample_text: str) -> Optional[BaseBankParser]:
        """
        Scan first page text to auto-detect bank parser plugin.
        """
        for parser in self._parsers:
            if parser.detect(sample_text):
                return parser
        return None

# Singleton registry instance
registry = ParserRegistry()
