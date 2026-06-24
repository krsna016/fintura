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

    def _normalize_dataframe(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.dropna(how='all')
        
        # Identify columns
        cols_lower = {str(c).lower(): c for c in df.columns}
        
        date_col = next((c for cl, c in cols_lower.items() if any(x in cl for x in ['date', 'txn date', 'value'])), None)
        narration_col = next((c for cl, c in cols_lower.items() if any(x in cl for x in ['narration', 'description', 'particulars', 'remarks'])), None)
        balance_col = next((c for cl, c in cols_lower.items() if any(x in cl for x in ['balance', 'bal'])), None)
        dr_col = next((c for cl, c in cols_lower.items() if any(x in cl for x in ['withdrawal', 'debit', 'dr'])), None)
        cr_col = next((c for cl, c in cols_lower.items() if any(x in cl for x in ['deposit', 'credit', 'cr'])), None)
        amount_col = next((c for cl, c in cols_lower.items() if any(x in cl for x in ['amount', 'txn amt'])), None)
        
        def process_row(row):
            try:
                date_val = str(row[date_col]).strip() if date_col and pd.notna(row[date_col]) else ""
                narration = str(row[narration_col]).strip() if narration_col and pd.notna(row[narration_col]) else ""
                
                amount = 0.0
                tx_type = "DR"
                if dr_col and cr_col:
                    amount_cr = self.clean_float(row.get(cr_col))
                    amount_dr = self.clean_float(row.get(dr_col))
                    if amount_cr > 0:
                        amount = amount_cr
                        tx_type = "CR"
                    else:
                        amount = amount_dr
                        tx_type = "DR"
                elif amount_col:
                    raw_amount = self.clean_float(row.get(amount_col))
                    amount = abs(raw_amount)
                    tx_type = "DR" if raw_amount < 0 else "CR"
                else:
                    return None  # Will be dropped
                    
                balance = row[balance_col] if balance_col and pd.notna(row[balance_col]) else 0.0
                
                return pd.Series({
                    "transaction_date": date_val,
                    "raw_narration": narration,
                    "amount": amount,
                    "type": tx_type,
                    "running_balance": balance
                })
            except Exception:
                return None
        
        parsed_df = df.apply(process_row, axis=1)
        # Drop rows that failed parsing
        if not parsed_df.empty:
            parsed_df = parsed_df.dropna(how='all')
        else:
            parsed_df = pd.DataFrame(columns=["transaction_date", "raw_narration", "amount", "type", "running_balance"])
            
        return parsed_df
