import re
import pandas as pd
import logging
import pdfplumber
from datetime import datetime
from app.parsers.base import BaseBankParser

logger = logging.getLogger(__name__)


class ICICIParser(BaseBankParser):
    def detect(self, first_page_text: str) -> bool:
        keywords = ["ICICI BANK", "ICICI Bank", "icicibank"]
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
        if file_path.endswith('.pdf'):
            df = self._parse_pdf(file_path)
        elif file_path.endswith(('.xlsx', '.xls')):
            df = self._parse_excel(file_path)
        elif file_path.endswith('.csv'):
            df = self._parse_csv(file_path)
        else:
            raise ValueError("Unsupported file format for ICICI statement")
            
        return self.normalize(df)

    def _parse_pdf(self, file_path: str) -> pd.DataFrame:
        rows = []
        date_pattern = re.compile(r'^\d{2}[-/\s]\d{2}[-/\s]\d{4}$')
        alt_date_pattern = re.compile(r'^\d{2}[-/\s][a-zA-Z]{3}[-/\s]\d{4}$')

        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                table = page.extract_table()
                if not table:
                    text = page.extract_text()
                    if text:
                        rows.extend(self._parse_lines(text.split('\n')))
                    continue

                for row in table:
                    cleaned_row = [str(item).strip() if item else "" for item in row]
                    if not cleaned_row or len(cleaned_row) < 5:
                        continue
                        
                    first_val = cleaned_row[0].replace('\n', ' ')
                    if not (date_pattern.match(first_val) or alt_date_pattern.match(first_val)):
                        if len(cleaned_row) > 1:
                            second_val = cleaned_row[1].replace('\n', ' ')
                            if date_pattern.match(second_val) or alt_date_pattern.match(second_val):
                                cleaned_row = cleaned_row[1:]
                            else:
                                continue
                        else:
                            continue

                    rows.append(cleaned_row)

        return self._normalize_rows(rows)

    def _parse_lines(self, lines: list[str]) -> list[list[str]]:
        extracted = []
        row_regex = re.compile(r'^(\d{2}[-/\s]\w{2,3}[-/\s]\d{4})\s+(.*?)\s+([\d,]+\.\d{2})\s*(CR|DR)?\s+([\d,]+\.\d{2})$', re.IGNORECASE)
        for line in lines:
            match = row_regex.match(line.strip())
            if match:
                extracted.append([
                    match.group(1),
                    match.group(2),
                    match.group(3),
                    match.group(4) or "DR",
                    match.group(5)
                ])
        return extracted

    def _parse_excel(self, file_path: str) -> pd.DataFrame:
        df = pd.read_excel(file_path)
        return self._normalize_dataframe(df)

    def _parse_csv(self, file_path: str) -> pd.DataFrame:
        df = pd.read_csv(file_path)
        return self._normalize_dataframe(df)

    def _normalize_rows(self, raw_rows: list[list[str]]) -> pd.DataFrame:
        parsed_data = []
        for r in raw_rows:
            try:
                date_str = r[0]
                if len(r) >= 6:
                    narration = r[2].replace('\n', ' ')
                    dr_val = r[3].replace(',', '').strip()
                    cr_val = r[4].replace(',', '').strip()
                    balance_val = r[5].replace(',', '').strip()
                    
                    if cr_val and cr_val != "0" and cr_val != "0.00" and not cr_val.isspace():
                        amount = cr_val
                        tx_type = "CR"
                    else:
                        amount = dr_val
                        tx_type = "DR"
                    balance = balance_val
                else:
                    narration = r[1].replace('\n', ' ')
                    amount_val = r[2]
                    tx_type = "CR" if "CR" in r[3].upper() else "DR"
                    balance_val = r[4]
                    amount = amount_val
                    balance = balance_val

                parsed_data.append({
                    "transaction_date": date_str,
                    "raw_narration": narration,
                    "amount": amount,
                    "type": tx_type,
                    "running_balance": balance
                })
            except Exception as e:
                print(f"Error parsing row {r}: {e}")
                continue

        return pd.DataFrame(parsed_data)

