import re
from abc import ABC, abstractmethod
import pandas as pd
from datetime import datetime

class BaseBankParser(ABC):
    @abstractmethod
    def detect(self, first_page_text: str) -> bool:
        """
        Analyze raw text from page 1 to check if format belongs to this bank.
        """
        pass

    @abstractmethod
    def parse(self, file_path: str) -> pd.DataFrame:
        """
        Extract statements and return DataFrame.
        """
        pass

    @abstractmethod
    def validate(self, df: pd.DataFrame) -> bool:
        """
        Validate that the parsed DataFrame contains all required columns:
        ['transaction_date', 'raw_narration', 'amount', 'type', 'running_balance']
        """
        pass

    @abstractmethod
    def normalize(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Normalize the parsed DataFrame to standardized formats.
        """
        pass

    def clean_float(self, val: any) -> float:
        """
        Robustly parses a numeric cell (supports currency suffixes, spaces, CR/DR suffix, empty cells).
        """
        if pd.isna(val) or val is None:
            return 0.0
        val_str = str(val).replace(',', '').strip().upper()
        
        # Keep only digits, decimal point, and minus sign
        cleaned = re.sub(r'[^\d\.\-]', '', val_str)
        try:
            return float(cleaned) if cleaned else 0.0
        except ValueError:
            return 0.0

    def clean_date(self, date_str: str) -> str:
        """
        Standardizes date strings (DD-MM-YYYY, YYYY-MM-DD, with or without time) to standard format.
        Preserves time if present.
        """
        if pd.isna(date_str) or not date_str:
            return ""
            
        date_clean = str(date_str).strip().replace('\n', ' ')
        
        # Check if time is present
        time_part = ""
        date_part = date_clean
        
        if ' ' in date_clean:
            parts = date_clean.split(' ')
            date_part = parts[0]
            time_part = " ".join(parts[1:]).strip()
        elif 'T' in date_clean:
            parts = date_clean.split('T')
            date_part = parts[0]
            time_part = parts[1].strip()

        # Clean date part
        cleaned_date = ""
        for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d", "%Y/%m/%d"):
            try:
                dt = datetime.strptime(date_part, fmt)
                cleaned_date = dt.strftime("%Y-%m-%d")
                break
            except ValueError:
                continue
                
        if not cleaned_date:
            return ""
            
        # Clean time part if present
        if time_part:
            # Strip time zone if it ends with Z or +HH:MM / -HH:MM
            time_part = re.split(r'[Z\+\-]', time_part)[0].strip()
            # Try parsing time formats
            for t_fmt in ("%H:%M:%S.%f", "%H:%M:%S", "%H:%M"):
                try:
                    t_val = datetime.strptime(time_part, t_fmt).time()
                    return f"{cleaned_date} {t_val.strftime('%H:%M:%S')}"
                except ValueError:
                    continue
                    
        return cleaned_date
