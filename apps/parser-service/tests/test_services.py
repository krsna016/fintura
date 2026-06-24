import pytest
from app.services.cleaner import normalize_date, clean_amount

def test_normalize_date_edge_cases():
    assert normalize_date("01-01-2024") == "2024-01-01"
    assert normalize_date("31/12/2023") == "2023-12-31"
    assert normalize_date("invalid_date") == None

def test_clean_amount_edge_cases():
    assert clean_amount("₹ 1,000.50") == 1000.50
    assert clean_amount("1,00,000.00 Cr") == 100000.00
    assert clean_amount("Invalid") == 0.0
