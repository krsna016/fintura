import pytest
import pandas as pd
from app.services.cleaner import clean_narration
from app.services.detector import registry

def test_clean_narration_upi():
    # Test typical UPI narration patterns
    upi_sample = "UPI/612349081230/RAKESH ENTERP/HDFC/upi-ref-id"
    party, mode = clean_narration(upi_sample)
    assert party == "Rakesh Enterp"
    assert mode == "UPI"

    upi_sample_2 = "UPI-SHYAM TRANSPORTS-82930491820"
    party, mode = clean_narration(upi_sample_2)
    assert party == "Shyam Transports"
    assert mode == "UPI"

def test_clean_narration_imps():
    imps_sample = "IMPS/630129031203/MOHIT KUMAR/IMPS-REF"
    party, mode = clean_narration(imps_sample)
    assert party == "Mohit Kumar"
    assert mode == "IMPS"

def test_clean_narration_neft():
    neft_sample = "NEFT-SBIN000123-AMIT LOGISTICS-REF"
    party, mode = clean_narration(neft_sample)
    assert party == "Amit Logistics"
    assert mode == "NEFT"

def test_clean_narration_charges():
    charges_sample = "CONSOLIDATED CHG FOR DEC 2025"
    party, mode = clean_narration(charges_sample)
    assert party == "Bank Charges"
    assert mode == "CHARGES"

def test_bank_detection():
    # Mock text matching page 1 of ICICI Statement
    icici_header = "ICICI BANK LTD\nCorporate Account Statement\nDate Range: 01/01/2026 to 31/01/2026"
    parser = registry.detect(icici_header)
    assert parser is not None
    assert parser.__class__.__name__ == "ICICIParser"

    # Mock text matching YES Bank
    yes_header = "YES BANK LTD\nCustomer Statement\nAccount Number: 12345"
    parser = registry.detect(yes_header)
    assert parser is not None
    assert parser.__class__.__name__ == "YesBankParser"

    # Mock text matching IDFC First
    idfc_header = "IDFC FIRST Bank Statement\nStatement of Account for the Period..."
    parser = registry.detect(idfc_header)
    assert parser is not None
    assert parser.__class__.__name__ == "IDFCFirstParser"
