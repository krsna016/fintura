import re
import pandas as pd
from app.parsers.base import BaseBankParser

class AxisParser(BaseBankParser):
    def detect(self, first_page_text: str) -> bool:
        keywords = ["AXIS BANK", "Axis Bank", "axisbank"]
        first_page_upper = first_page_text.upper()
        return any(kw in first_page_upper for kw in keywords)

    def validate(self, df: pd.DataFrame) -> bool:
        required = ['transaction_date', 'raw_narration', 'amount', 'type', 'running_balance']
        return all(col in df.columns for col in required)

    def normalize(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        df['transaction_date'] = df['transaction_date'].apply(self.clean_date)
        df['amount'] = df['amount'].apply(self.clean_float)
        df['type'] = df['type'].apply(lambda x: "CR" if str(x).strip().upper() == "CR" else "DR")
        df['running_balance'] = df['running_balance'].apply(self.clean_float)
        return df

    def parse(self, file_path: str) -> pd.DataFrame:
        # Axis parser standard fallback (parsing using dynamic column detection)
        if file_path.endswith('.pdf'):
            import pdfplumber
            rows = []
            date_pattern = re.compile(r'^\d{2}[-/\s]\d{2}[-/\s]\d{4}$')
            with pdfplumber.open(file_path) as pdf:
                for page in pdf.pages:
                    table = page.extract_table()
                    if table:
                        for row in table:
                            cleaned_row = [str(item).strip() if item else "" for item in row]
                            if cleaned_row and len(cleaned_row) >= 5 and date_pattern.match(cleaned_row[0]):
                                rows.append(cleaned_row)
            if rows:
                df = self._normalize_rows(rows)
            else:
                df = pd.DataFrame(columns=['transaction_date', 'raw_narration', 'amount', 'type', 'running_balance'])
        elif file_path.endswith(('.xlsx', '.xls')):
            df = pd.read_excel(file_path)
            df = self._normalize_dataframe(df)
        elif file_path.endswith('.csv'):
            df = pd.read_csv(file_path)
            df = self._normalize_dataframe(df)
        else:
            raise ValueError("Unsupported format for Axis statement")
            
        return self.normalize(df)

    def _normalize_rows(self, raw_rows: list[list[str]]) -> pd.DataFrame:
        parsed_data = []
        for r in raw_rows:
            try:
                date_str = r[0]
                if len(r) >= 6:
                    narration = r[1]
                    amount_dr = self.clean_float(r[3])
                    amount_cr = self.clean_float(r[4])
                    balance = r[5]
                    
                    if amount_cr > 0:
                        amount = amount_cr
                        tx_type = "CR"
                    else:
                        amount = amount_dr
                        tx_type = "DR"
                else:
                    narration = r[1]
                    amount = r[2]
                    tx_type = "CR" if "CR" in r[3].upper() else "DR"
                    balance = r[4]
                parsed_data.append({
                    "transaction_date": date_str,
                    "raw_narration": narration,
                    "amount": amount,
                    "type": tx_type,
                    "running_balance": balance
                })
            except Exception:
                continue
        return pd.DataFrame(parsed_data)

    def _normalize_dataframe(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.dropna(how='all')
        date_col = next((col for col in df.columns if any(x in str(col).lower() for x in ['date', 'txn date', 'value'])), None)
        narration_col = next((col for col in df.columns if any(x in str(col).lower() for x in ['narration', 'description', 'particulars', 'remarks'])), None)
        balance_col = next((col for col in df.columns if any(x in str(col).lower() for x in ['balance', 'bal'])), None)
        dr_col = next((col for col in df.columns if any(x in str(col).lower() for x in ['withdrawal', 'debit', 'dr'])), None)
        cr_col = next((col for col in df.columns if any(x in str(col).lower() for x in ['deposit', 'credit', 'cr'])), None)
        amount_col = next((col for col in df.columns if any(x in str(col).lower() for x in ['amount', 'txn amt'])), None)

        parsed_data = []
        for _, row in df.iterrows():
            try:
                date_val = str(row[date_col]).strip() if date_col else ""
                narration = str(row[narration_col]).strip() if narration_col else ""
                if dr_col and cr_col:
                    amount_cr = self.clean_float(row[cr_col])
                    amount_dr = self.clean_float(row[dr_col])
                    if amount_cr > 0:
                        amount = amount_cr
                        tx_type = "CR"
                    else:
                        amount = amount_dr
                        tx_type = "DR"
                elif amount_col:
                    amount = row[amount_col]
                    tx_type = "DR" if self.clean_float(amount) < 0 else "CR"
                    amount = abs(self.clean_float(amount))
                else:
                    continue
                balance = row[balance_col] if balance_col else 0.0
                parsed_data.append({
                    "transaction_date": date_val,
                    "raw_narration": narration,
                    "amount": amount,
                    "type": tx_type,
                    "running_balance": balance
                })
            except Exception:
                continue
        return pd.DataFrame(parsed_data)
