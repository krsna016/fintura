import os
import re
import json
import tempfile
import traceback
import pandas as pd
import pdfplumber
from datetime import datetime
from fastapi import FastAPI, BackgroundTasks, HTTPException, status
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from app.core.db import get_supabase_client
from app.services.detector import registry
from app.services.cleaner import clean_narration
from app.services.ocr import extract_invoice_data

from app.core.config import settings

app = FastAPI(title="Transaction Intelligence Parser Service", version="1.0.0")

# Parse allowed origins from configuration settings
allowed_origins_list = [origin.strip() for origin in settings.ALLOWED_ORIGINS.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ProcessJobRequest(BaseModel):
    job_id: str
    file_path: str

class ApplyMappingRequest(BaseModel):
    job_id: str
    file_path: str
    date_col: int
    narration_col: int
    amount_col: int = -1
    type_col: int = -1
    debit_col: int = -1
    credit_col: int = -1
    balance_col: int = -1
    header_row_index: int = 0

def clean_val_float(val: str) -> float:
    if not val:
        return 0.0
    val_str = str(val).replace(',', '').strip().upper()
    cleaned = re.sub(r'[^\d\.\-]', '', val_str)
    try:
        return float(cleaned) if cleaned else 0.0
    except ValueError:
        return 0.0

def clean_val_date(date_str: str) -> str:
    if not date_str:
        return ""
    date_clean = str(date_str).strip().replace('\n', ' ')
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

    cleaned_date = ""
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            dt = datetime.strptime(date_part, fmt)
            cleaned_date = dt.strftime("%Y-%m-%d")
            break
        except ValueError:
            continue
            
    if not cleaned_date:
        return date_clean # Fallback to original string if not parsed
        
    if time_part:
        # Strip time zone if it ends with Z or +HH:MM / -HH:MM
        time_part = re.split(r'[Z\+\-]', time_part)[0].strip()
        for t_fmt in ("%H:%M:%S.%f", "%H:%M:%S", "%H:%M"):
            try:
                t_val = datetime.strptime(time_part, t_fmt).time()
                return f"{cleaned_date} {t_val.strftime('%H:%M:%S')}"
            except ValueError:
                continue
                
    return cleaned_date

def extract_raw_grid(file_path: str) -> list[list[str]]:
    """
    Extracts raw text/table grid from any CSV, Excel, or PDF file as a list of lists of strings.
    """
    ext = os.path.splitext(file_path)[1].lower()
    rows = []
    if ext == '.csv':
        try:
            df = pd.read_csv(file_path, header=None)
            rows = df.fillna("").astype(str).values.tolist()
        except Exception as e:
            print(f"CSV read error: {e}")
    elif ext in ['.xlsx', '.xls']:
        try:
            df = pd.read_excel(file_path, header=None)
            rows = df.fillna("").astype(str).values.tolist()
        except Exception as e:
            print(f"Excel read error: {e}")
    elif ext == '.pdf':
        try:
            with pdfplumber.open(file_path) as pdf:
                for page in pdf.pages:
                    table = page.extract_table()
                    if table:
                        for row in table:
                            cleaned_row = [str(item).strip() if item else "" for item in row]
                            rows.append(cleaned_row)
                    else:
                        text = page.extract_text()
                        if text:
                            for line in text.split('\n'):
                                parts = re.split(r'\s{2,}', line.strip())
                                if len(parts) > 1:
                                    rows.append(parts)
        except Exception as e:
            print(f"PDF extract error: {e}")
    return rows

def process_statement_background(job_id: str, file_path: str):
    """
    Downloads, parses, and ingests bank statements asynchronously.
    """
    supabase = get_supabase_client()
    local_temp_path = None

    try:
        # 1. Update job status to PROCESSING
        supabase.table("parsing_jobs").update({
            "status": "PROCESSING"
        }).eq("id", job_id).execute()

        # 2. Download raw file from Supabase Storage
        bucket_name = "statements"
        file_data = supabase.storage.from_(bucket_name).download(file_path)

        # Create a temporary file locally to process it
        ext = os.path.splitext(file_path)[1].lower()
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp_file:
            tmp_file.write(file_data)
            local_temp_path = tmp_file.name

        # 3. Detect bank from statement page 1
        bank_name = None
        first_page_text = ""
        
        if ext == '.pdf':
            with pdfplumber.open(local_temp_path) as pdf:
                if len(pdf.pages) > 0:
                    first_page_text = pdf.pages[0].extract_text() or ""
        else:
            try:
                df_temp = pd.read_excel(local_temp_path, nrows=10) if ext in ['.xlsx', '.xls'] else pd.read_csv(local_temp_path, nrows=10)
                first_page_text = f"{' '.join(map(str, df_temp.columns))} {df_temp.to_string()}"
            except Exception as pe:
                print(f"Error reading CSV/Excel headers: {pe}")
                with open(local_temp_path, 'rb') as f:
                    first_page_text = f.read(2048).decode('utf-8', errors='ignore')

        # Run detection registry
        parser = registry.detect(first_page_text)
        if not parser:
            if ext in ['.csv', '.xlsx', '.xls']:
                from app.parsers.icici_parser import ICICIParser
                parser = ICICIParser()
                print("No specific bank format detected. Falling back to generic spreadsheet parser.")
            else:
                parser = None

        df = None
        if parser:
            try:
                df = parser.parse(local_temp_path)
            except Exception as pe:
                print(f"Parser plugin failed to parse file: {pe}")
                df = None

        # 4. If automatic parsing fails, fall back to Manual Mapping Wizard
        if df is None or df.empty:
            print("Automatic parsing failed. Attempting generic extraction for manual mapping...")
            raw_grid = extract_raw_grid(local_temp_path)
            if not raw_grid or len(raw_grid) == 0:
                raise ValueError("No transaction rows could be parsed from the statement and generic extraction failed.")
            
            # Save raw grid to Supabase Storage as a JSON file
            raw_json_data = json.dumps(raw_grid)
            raw_json_path = file_path.replace(ext, "_raw.json")
            
            supabase.storage.from_("statements").upload(
                raw_json_path,
                raw_json_data.encode('utf-8'),
                {"content-type": "application/json"}
            )
            
            # Update job status to MAPPING_REQUIRED
            supabase.table("parsing_jobs").update({
                "status": "MAPPING_REQUIRED",
                "file_path": file_path
            }).eq("id", job_id).execute()
            return

        # Identify which bank subclass matched
        parser_name = parser.__class__.__name__
        if "ICICI" in parser_name:
            bank_name = "ICICI"
        elif "YesBank" in parser_name:
            bank_name = "YES_BANK"
        elif "IDFC" in parser_name:
            bank_name = "IDFC_FIRST"
        elif "HDFC" in parser_name:
            bank_name = "HDFC"
        elif "Axis" in parser_name:
            bank_name = "AXIS"
        else:
            bank_name = "UNKNOWN"

        # Update detected bank
        supabase.table("parsing_jobs").update({
            "bank_detected": bank_name
        }).eq("id", job_id).execute()

        # Get organization_id from the job record
        job_data = supabase.table("parsing_jobs").select("organization_id").eq("id", job_id).single().execute()
        if not job_data.data:
            raise ValueError("Job record not found in database.")
        org_id = job_data.data["organization_id"]

        # 5. Normalize, clean, and build insert records
        transactions_to_insert = []
        for _, row in df.iterrows():
            raw_desc = str(row["raw_narration"])
            cleaned_party, mode = clean_narration(raw_desc)
            
            transactions_to_insert.append({
                "job_id": job_id,
                "organization_id": org_id,
                "transaction_date": str(row["transaction_date"]),
                "raw_narration": raw_desc,
                "cleaned_party": cleaned_party,
                "transaction_mode": mode,
                "type": str(row["type"]).upper(),
                "amount": float(row["amount"]),
                "running_balance": float(row["running_balance"])
            })

        # Insert in batches of 100 to prevent payload limit issues
        batch_size = 100
        for i in range(0, len(transactions_to_insert), batch_size):
            batch = transactions_to_insert[i:i + batch_size]
            supabase.table("transactions").insert(batch).execute()

        # 6. Mark Job Completed
        supabase.table("parsing_jobs").update({
            "status": "COMPLETED",
            "total_rows": len(transactions_to_insert),
            "completed_at": "now()"
        }).eq("id", job_id).execute()

    except Exception as e:
        error_msg = str(e)
        print(f"Failed to process job {job_id}: {error_msg}")
        traceback.print_exc()
        
        # Mark Job as FAILED
        try:
            supabase.table("parsing_jobs").update({
                "status": "FAILED",
                "error_message": error_msg[:500]
            }).eq("id", job_id).execute()
        except Exception as db_err:
            print(f"Failed to update failed job status: {db_err}")

    finally:
        # Clean up temporary file
        if local_temp_path and os.path.exists(local_temp_path):
            try:
                os.remove(local_temp_path)
            except Exception as e:
                print(f"Error removing temp file: {e}")

def apply_mapping_background(
    job_id: str,
    file_path: str,
    date_col: int,
    narration_col: int,
    amount_col: int,
    type_col: int,
    debit_col: int,
    credit_col: int,
    balance_col: int,
    header_row_index: int
):
    supabase = get_supabase_client()
    local_temp_path = None

    try:
        # 1. Update job status to PROCESSING
        supabase.table("parsing_jobs").update({
            "status": "PROCESSING"
        }).eq("id", job_id).execute()

        # 2. Download raw file from Supabase Storage
        bucket_name = "statements"
        file_data = supabase.storage.from_(bucket_name).download(file_path)

        # Create temporary file locally
        ext = os.path.splitext(file_path)[1].lower()
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp_file:
            tmp_file.write(file_data)
            local_temp_path = tmp_file.name

        # 3. Extract raw grid
        raw_grid = extract_raw_grid(local_temp_path)
        if not raw_grid or len(raw_grid) <= header_row_index + 1:
            raise ValueError("Insufficient rows in the statement to apply mapping.")

        # Get organization_id from the job record
        job_data = supabase.table("parsing_jobs").select("organization_id").eq("id", job_id).single().execute()
        if not job_data.data:
            raise ValueError("Job record not found in database.")
        org_id = job_data.data["organization_id"]

        transactions_to_insert = []

        for r_idx in range(header_row_index + 1, len(raw_grid)):
            row = raw_grid[r_idx]
            max_idx = max(date_col, narration_col, amount_col, type_col, debit_col, credit_col, balance_col)
            if len(row) <= max_idx:
                continue

            date_raw = str(row[date_col]).strip()
            if not date_raw:
                continue
            date_val = clean_val_date(date_raw)

            raw_desc = str(row[narration_col]).strip()
            if not raw_desc:
                continue

            amount = 0.0
            tx_type = "DR"

            if debit_col >= 0 and credit_col >= 0:
                dr_val = clean_val_float(row[debit_col])
                cr_val = clean_val_float(row[credit_col])
                if cr_val > 0:
                    amount = cr_val
                    tx_type = "CR"
                else:
                    amount = dr_val
                    tx_type = "DR"
            elif amount_col >= 0:
                amount_val = clean_val_float(row[amount_col])
                if type_col >= 0:
                    type_str = str(row[type_col]).strip().upper()
                    tx_type = "CR" if "CR" in type_str or "CREDIT" in type_str else "DR"
                    amount = abs(amount_val)
                else:
                    tx_type = "DR" if amount_val < 0 else "CR"
                    amount = abs(amount_val)
            else:
                continue

            balance = clean_val_float(row[balance_col]) if balance_col >= 0 else 0.0

            # Run cleaner narration rules
            cleaned_party, mode = clean_narration(raw_desc)

            transactions_to_insert.append({
                "job_id": job_id,
                "organization_id": org_id,
                "transaction_date": date_val,
                "raw_narration": raw_desc,
                "cleaned_party": cleaned_party,
                "transaction_mode": mode,
                "type": tx_type,
                "amount": amount,
                "running_balance": balance
            })

        if not transactions_to_insert:
            raise ValueError("No transaction rows could be parsed using the specified column mapping.")

        # Clean existing transactions for this job if any
        supabase.table("transactions").delete().eq("job_id", job_id).execute()

        # Insert in batches of 100
        batch_size = 100
        for i in range(0, len(transactions_to_insert), batch_size):
            batch = transactions_to_insert[i:i + batch_size]
            supabase.table("transactions").insert(batch).execute()

        # Mark Job Completed
        supabase.table("parsing_jobs").update({
            "status": "COMPLETED",
            "total_rows": len(transactions_to_insert),
            "completed_at": "now()"
        }).eq("id", job_id).execute()

    except Exception as e:
        error_msg = str(e)
        print(f"Failed to apply mapping for job {job_id}: {error_msg}")
        traceback.print_exc()
        
        # Mark Job as FAILED
        try:
            supabase.table("parsing_jobs").update({
                "status": "FAILED",
                "error_message": error_msg[:500]
            }).eq("id", job_id).execute()
        except Exception as db_err:
            print(f"Failed to update failed job status: {db_err}")

    finally:
        # Clean up temporary file
        if local_temp_path and os.path.exists(local_temp_path):
            try:
                os.remove(local_temp_path)
            except Exception as e:
                print(f"Error removing temp file: {e}")

@app.post("/process-statement", status_code=status.HTTP_202_ACCEPTED)
async def process_statement(request: ProcessJobRequest, background_tasks: BackgroundTasks):
    """
    Triggers asynchronous bank statement parsing.
    """
    background_tasks.add_task(
        process_statement_background,
        job_id=request.job_id,
        file_path=request.file_path
    )
    return {"status": "ACKNOWLEDGED"}

@app.post("/apply-mapping", status_code=status.HTTP_202_ACCEPTED)
async def apply_mapping(request: ApplyMappingRequest, background_tasks: BackgroundTasks):
    """
    Triggers dynamic transaction parsing based on manual column mapping.
    """
    background_tasks.add_task(
        apply_mapping_background,
        job_id=request.job_id,
        file_path=request.file_path,
        date_col=request.date_col,
        narration_col=request.narration_col,
        amount_col=request.amount_col,
        type_col=request.type_col,
        debit_col=request.debit_col,
        credit_col=request.credit_col,
        balance_col=request.balance_col,
        header_row_index=request.header_row_index
    )
    return {"status": "ACKNOWLEDGED"}

class ProcessInvoiceRequest(BaseModel):
    invoice_id: str
    file_path: str

def process_invoice_background(invoice_id: str, file_path: str):
    """
    Downloads, OCRs, and parses invoice documents asynchronously using Gemini API.
    """
    supabase = get_supabase_client()
    try:
        # 1. Update invoice status to PROCESSING
        supabase.table("invoices").update({
            "status": "PROCESSING"
        }).eq("id", invoice_id).execute()

        # 2. Download raw file from Supabase Storage
        bucket_name = "invoices"
        file_data = supabase.storage.from_(bucket_name).download(file_path)

        # Determine MIME type based on file extension
        ext = os.path.splitext(file_path)[1].lower()
        if ext == '.pdf':
            mime_type = 'application/pdf'
        elif ext == '.png':
            mime_type = 'image/png'
        elif ext in ['.jpg', '.jpeg']:
            mime_type = 'image/jpeg'
        else:
            mime_type = 'application/octet-stream'

        # 3. Call structured OCR extraction service
        extracted_data = extract_invoice_data(file_data, mime_type)

        # 4. Save extracted metadata back to invoices table
        metadata_update = {
            "invoice_number": extracted_data.get("invoice_number"),
            "invoice_date": extracted_data.get("invoice_date"),
            "due_date": extracted_data.get("due_date"),
            "vendor_name": extracted_data.get("vendor_name"),
            "vendor_address": extracted_data.get("vendor_address"),
            "vendor_tax_id": extracted_data.get("vendor_tax_id"),
            "customer_name": extracted_data.get("customer_name"),
            "customer_address": extracted_data.get("customer_address"),
            "customer_tax_id": extracted_data.get("customer_tax_id"),
            "subtotal": extracted_data.get("subtotal"),
            "tax_amount": extracted_data.get("tax_amount"),
            "discount": extracted_data.get("discount"),
            "total_amount": extracted_data.get("total_amount"),
            "currency": extracted_data.get("currency", "INR"),
            "status": "COMPLETED",
            "completed_at": "now()"
        }
        
        supabase.table("invoices").update(metadata_update).eq("id", invoice_id).execute()

        # 5. Insert line items
        items = extracted_data.get("items", [])
        if items:
            # Delete any existing line items for this invoice
            supabase.table("invoice_items").delete().eq("invoice_id", invoice_id).execute()
            
            items_to_insert = []
            for item in items:
                items_to_insert.append({
                    "invoice_id": invoice_id,
                    "description": item.get("description", "Unknown Item"),
                    "quantity": float(item.get("quantity", 1.0)),
                    "unit_price": float(item.get("unit_price", 0.0)),
                    "tax_rate": float(item.get("tax_rate", 0.0)),
                    "tax_amount": float(item.get("tax_amount", 0.0)),
                    "total": float(item.get("total", 0.0))
                })
            
            # Batch insert in chunks of 50
            batch_size = 50
            for i in range(0, len(items_to_insert), batch_size):
                batch = items_to_insert[i:i + batch_size]
                supabase.table("invoice_items").insert(batch).execute()

    except Exception as e:
        error_msg = str(e)
        print(f"Failed to process invoice {invoice_id}: {error_msg}")
        traceback.print_exc()

        # Mark invoice as FAILED
        try:
            supabase.table("invoices").update({
                "status": "FAILED",
                "error_message": error_msg[:500]
            }).eq("id", invoice_id).execute()
        except Exception as db_err:
            print(f"Failed to update failed invoice status: {db_err}")

@app.post("/process-invoice", status_code=status.HTTP_202_ACCEPTED)
async def process_invoice(request: ProcessInvoiceRequest, background_tasks: BackgroundTasks):
    """
    Triggers asynchronous invoice OCR parsing.
    """
    background_tasks.add_task(
        process_invoice_background,
        invoice_id=request.invoice_id,
        file_path=request.file_path
    )
    return {"status": "ACKNOWLEDGED"}

@app.get("/health")
async def health():
    return {"status": "healthy"}
