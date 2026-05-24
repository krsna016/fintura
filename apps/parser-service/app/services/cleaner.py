import re

SUPPORTED_MODES = ["RTGS", "NEFT", "IMPS", "UPI", "ACH", "CMS", "CHQ", "DD", "IFT", "FT", "TRF"]

def parse_transaction(raw_narration: str) -> dict:
    """
    Cleans raw bank narration text and extracts:
    - Counterparty Name (party)
    - Transaction Mode (RTGS, NEFT, IMPS, UPI, ACH, CMS, CHQ, DD, IFT, FT, TRF)
    - Confidence Score
    - Parsing Method
    - Ignored Tokens
    """
    upper_raw = raw_narration.upper().strip()
    
    party = "UNKNOWN"
    mode = "UNKNOWN"
    ignored_tokens = []
    detected_mode = "UNKNOWN"
    
    # Exclude internal tenant references
    def clean_vinayak(name_str: str) -> str:
        vinayak_patterns = [
            r'\bVINAYAK\s*LOGISTICS\s*INDIA\s*P\b',
            r'\bVINAYAK\s*LOGISTICS\s*PVT\s*LTD\b',
            r'\bVINAYAK\s*LOGISTICS\s*INDIA\s*PVT\s*LTD\b',
            r'\bVINAYAK\s*LOGISTICS\b',
            r'\bVINAYAK\s*COATINGS\s*PRIVATE\s*LIMITED\b',
            r'\bVINAYAK\s*COATINGS\b',
            r'\bVINAYAK\s*INDIA\b',
            r'\bVINAYAKLOGISTICSINDIAPVTL\b',
            r'\bVINAYAKLOGISTICS\b',
        ]
        for vp in vinayak_patterns:
            name_str = re.sub(vp, '', name_str, flags=re.IGNORECASE).strip()
        return name_str

    # Helper to scan for ignored tokens in raw string using strict word boundaries
    def extract_ignored(s: str) -> list:
        found = []
        patterns = [
            r'\b[A-Z]{4}\d[A-Z0-9]{5,6}\b', # IFSC code (4 letters, 1 number, 5 or 6 alphanumeric)
            r'\bYESIG\d+\b|\b[A-Z]{5}\d{11}\b', # YESIG codes
            r'\b(?:RRN|REF):?\s*\d+\b|\bRRN\d+\b|\bREF\d+\b', # RRN/REF
            r'\b\d{4,}\b', # Digits
            r'\bX{3,}\d*\b', # Obscured numbers
            r'\b(?:GOOGLEPAY|PHONEPE|PAYTM|BHIM|GPAY|G-PAY)\b',
            r'\bNEFT[A-Z0-9]{6,}\b', # NEFT reference codes (e.g. NEFTGFRT..., NEFTGSDE...)
            r'\b[A-Z]{4}R\d+\b', # Bank references like HDFCR..., SBINR...
            r'\bVINAYAK\s*INDIA\b'
        ]
        for pat in patterns:
            for m in re.findall(pat, s, re.IGNORECASE):
                if m not in found:
                    found.append(m)
        return found

    ignored_tokens = extract_ignored(raw_narration)

    # 1. SPECIAL YES BANK NEFT RULE:
    # NEFT O/W-YESIGXXXXXXXXXX-PARTY NAME-NEFTXXXXXXXXXX-VINAYAK INDIA
    # Extract text between YESIGXXXXXXXXXX and NEFTXXXXXXXXXX
    # Note: We support both hyphens and spaces/other characters separating tokens.
    yes_neft_match = re.search(r'YESIG\d+[- ]+(.*?)[- ]+NEFT[A-Z0-9]+', upper_raw)
    if yes_neft_match and ("NEFT O/W" in upper_raw or "NEFT O W" in upper_raw):
        party = yes_neft_match.group(1).strip()
        mode = "NEFT"
        
        # Collect exact matched tokens to ignore
        utr_match = re.search(r'\bYESIG\d+\b', upper_raw)
        ref_match = re.search(r'\bNEFT[A-Z0-9]+\b', upper_raw)
        if utr_match:
            m_val = raw_narration[utr_match.start():utr_match.end()]
            if m_val not in ignored_tokens:
                ignored_tokens.append(m_val)
        if ref_match:
            m_val = raw_narration[ref_match.start():ref_match.end()]
            if m_val not in ignored_tokens:
                ignored_tokens.append(m_val)
        if "VINAYAK INDIA" in upper_raw:
            vi_idx = upper_raw.find("VINAYAK INDIA")
            m_val = raw_narration[vi_idx:vi_idx+len("VINAYAK INDIA")]
            if m_val not in ignored_tokens:
                ignored_tokens.append(m_val)
            
        # Clean the extracted party using all ignored tokens!
        for token in ignored_tokens:
            party = re.sub(r'\b' + re.escape(token.upper()) + r'\b|' + re.escape(token.upper()), ' ', party)
            
        party = clean_vinayak(party)
        party = re.sub(r'[^A-Z0-9\s]', ' ', party)
        party = re.sub(r'\s+', ' ', party).strip().upper()
        
        cleaned_narration = raw_narration
        for token in ignored_tokens:
            cleaned_narration = cleaned_narration.replace(token, "")
        cleaned_narration = re.sub(r'[-/]{2,}', '-', cleaned_narration)
        cleaned_narration = cleaned_narration.strip("-/ ")
        
        return {
            "raw_narration": raw_narration,
            "cleaned_narration": cleaned_narration,
            "party_name": party,
            "transaction_mode": "NEFT",
            "confidence_score": 1.00,
            "parsing_method": "regex",
            "ignored_tokens": ignored_tokens
        }

    # 2. Pre-process to split cases like IMPSI123456789
    pre_ignored = []
    
    # Check for prepended modes followed by 'I' and tracking ID, like IMPSI614311899144
    for m in SUPPORTED_MODES:
        pattern = r'^' + re.escape(m) + r'I(\d+)$'
        match = re.match(pattern, upper_raw)
        if match:
            mode = m
            detected_mode = m
            tracking_id = "I" + match.group(1)
            pre_ignored.append(tracking_id)
            upper_raw = ""
            break

    # 3. Check legacy prefix-based structured formats
    matched_prefix = False
    
    # B/F Brought Forward / Balance Forwarded
    if upper_raw.startswith("B/F") or "BROUGHT FORWARD" in upper_raw or "BALANCE FORWARD" in upper_raw:
        party = "F"
        mode = "UNKNOWN"
        matched_prefix = True
    # CMS-TPT
    elif "CMS-TPT" in upper_raw or upper_raw.startswith("TPT-"):
        party = "TPT"
        mode = "UNKNOWN"
        matched_prefix = True
    # Cheque deposits
    elif upper_raw.startswith("CHQ DEP-") or upper_raw.startswith("CHQ DEPOSIT-") or upper_raw.startswith("CHEQUE DEPOSIT-"):
        parts = raw_narration.split('-')
        if len(parts) >= 2:
            party = parts[1].strip()
            mode = "CHQ"
            matched_prefix = True
    elif "CHQ DEP" in upper_raw or "CHQ DEPOSIT" in upper_raw or "CHEQUE DEPOSIT" in upper_raw:
        party = "CHQ DEPOSIT"
        mode = "CHQ"
        matched_prefix = True
    # NEFT Cr-
    elif upper_raw.startswith("NEFT CR-"):
        parts = raw_narration.split('-')
        if len(parts) >= 3:
            party = parts[2].strip()
            mode = "NEFT"
            matched_prefix = True
    # NEFT O/W-
    elif upper_raw.startswith("NEFT O/W-"):
        parts = raw_narration.split('-')
        if len(parts) >= 4:
            party = parts[3].strip()
            mode = "NEFT"
            matched_prefix = True
    # NEFT-
    elif upper_raw.startswith("NEFT-"):
        parts = raw_narration.split('-')
        if len(parts) >= 3:
            p1_clean = parts[1].strip()
            if p1_clean in ignored_tokens or any(t in p1_clean for t in ignored_tokens):
                party = parts[2].strip()
            else:
                party = parts[1].strip()
            mode = "NEFT"
            matched_prefix = True
        elif len(parts) >= 2:
            party = parts[1].strip()
            mode = "NEFT"
            matched_prefix = True
    # RTGS Cr-
    elif upper_raw.startswith("RTGS CR-"):
        parts = raw_narration.split('-')
        if len(parts) >= 3:
            party = parts[2].strip()
            mode = "RTGS"
            matched_prefix = True
    # RTGS-
    elif upper_raw.startswith("RTGS-"):
        parts = raw_narration.split('-')
        if len(parts) >= 4:
            party = parts[3].strip()
            mode = "RTGS"
            matched_prefix = True
        elif len(parts) >= 3:
            p1_clean = parts[1].strip()
            if p1_clean in ignored_tokens or any(t in p1_clean for t in ignored_tokens):
                party = parts[2].strip()
            else:
                party = parts[1].strip()
            mode = "RTGS"
            matched_prefix = True
        elif len(parts) >= 2:
            party = parts[1].strip()
            mode = "RTGS"
            matched_prefix = True
    # IMPS/
    elif upper_raw.startswith("IMPS/"):
        parts = raw_narration.split('/')
        if len(parts) >= 2:
            first_part = parts[1].strip()
            if re.match(r'^\d+$', first_part) and len(parts) >= 3:
                party = parts[2].strip()
            else:
                party = first_part
            mode = "IMPS"
            matched_prefix = True
    # Generic UPI/
    elif upper_raw.startswith("UPI/"):
        parts = raw_narration.split('/')
        if len(parts) >= 3:
            p2 = parts[2].strip()
            if p2.upper() in ["GOOGLEPAY", "PHONEPE", "PAYTM", "BHIM", "GPAY", "G-PAY"] and len(parts) >= 4:
                party = parts[3].strip()
            else:
                party = p2
            mode = "UPI"
            matched_prefix = True
    # UPI-
    elif upper_raw.startswith("UPI-"):
        parts = raw_narration.split('-')
        if len(parts) >= 2:
            party = parts[1].strip()
            mode = "UPI"
            matched_prefix = True

    # 4. Clean and normalize the extracted party from prefix matches
    if matched_prefix:
        cleaned_party = party
        for token in ignored_tokens:
            cleaned_party = re.sub(r'\b' + re.escape(token) + r'\b|' + re.escape(token), ' ', cleaned_party, flags=re.IGNORECASE)
        cleaned_party = re.sub(r'[-/\\:_]', ' ', cleaned_party)
        cleaned_party = clean_vinayak(cleaned_party)
        cleaned_party = re.sub(r'[^a-zA-Z0-9\s]', ' ', cleaned_party)
        cleaned_party = re.sub(r'\s+', ' ', cleaned_party).strip().upper()
        
        mode_indicators = ["CR", "DR", "O/W", "O-W", "I-W", "CREDIT", "DEBIT", "COLLECTION", "DEP", "DEPOSIT", "INWARD", "OUTWARD"]
        for ind in mode_indicators:
            cleaned_party = re.sub(r'\b' + re.escape(ind) + r'\b', ' ', cleaned_party, flags=re.IGNORECASE).strip()
        cleaned_party = re.sub(r'\s+', ' ', cleaned_party).strip()
        
        party = cleaned_party if cleaned_party else "UNKNOWN"
    else:
        # 5. Fallback to generic token replacement scan
        if detected_mode == "UNKNOWN":
            for m in SUPPORTED_MODES:
                pattern = r'\b' + re.escape(m) + r'\b|/' + re.escape(m) + r'/|-' + re.escape(m) + r'-|^' + re.escape(m) + r'[-/ ]'
                if re.search(pattern, upper_raw) or upper_raw.startswith(m + "/") or upper_raw.startswith(m + "-") or upper_raw.startswith(m + " "):
                    detected_mode = m
                    break
            mode = detected_mode
        else:
            mode = detected_mode
                
        # Heuristics based categorization for generic narration
        if any(x in upper_raw for x in ["CHG", "CHARGE", "CHARGES", "FEE", "TAX", "GST"]):
            party = "BANK CHARGES"
            mode = "CHARGES" if mode == "UNKNOWN" else mode
        elif any(x in upper_raw for x in ["CASH DEP", "CASH WDL", "CASH-WDL", "CASH WITHDRAWAL", "SELF"]):
            party = "SELF / CASH"
            mode = "CASH" if mode == "UNKNOWN" else mode
        elif any(x in upper_raw for x in ["CHEQUE", "CHQ"]):
            party = "CHEQUE CLEARED"
            mode = "CHEQUE" if mode == "UNKNOWN" else mode
        elif "INTEREST" in upper_raw:
            party = "BANK INTEREST RECEIVED"
            mode = "CHARGES" if mode == "UNKNOWN" else mode
        else:
            cleaned_for_party = upper_raw
            for token in ignored_tokens:
                token_escaped = re.escape(token.upper())
                cleaned_for_party = re.sub(r'\b' + token_escaped + r'\b|' + token_escaped, ' ', cleaned_for_party)
            for m in SUPPORTED_MODES:
                cleaned_for_party = re.sub(r'\b' + re.escape(m) + r'\b', ' ', cleaned_for_party)
            mode_indicators = ["CR", "DR", "O/W", "O-W", "I-W", "CREDIT", "DEBIT", "COLLECTION", "DEP", "DEPOSIT", "INWARD", "OUTWARD"]
            for ind in mode_indicators:
                cleaned_for_party = re.sub(r'\b' + re.escape(ind) + r'\b', ' ', cleaned_for_party)
            cleaned_for_party = re.sub(r'[-/\\:_]', ' ', cleaned_for_party)
            cleaned_for_party = clean_vinayak(cleaned_for_party)
            cleaned_for_party = re.sub(r'[^A-Z0-9\s]', ' ', cleaned_for_party)
            cleaned_for_party = re.sub(r'\s+', ' ', cleaned_for_party).strip()
            
            party = cleaned_for_party if cleaned_for_party else "UNKNOWN"

    party = party.upper()
    if party in ["F", "TPT", "CHQ DEPOSIT", "CHQ", "UNKNOWN", "BANK CHARGES", "SELF / CASH", "CHEQUE CLEARED", "BANK INTEREST RECEIVED"]:
        pass 
    elif len(party) <= 2 or not re.search(r'[A-Z]', party):
        party = "UNKNOWN"

    confidence_score = 1.00
    parsing_method = "regex"
    
    if party == "UNKNOWN":
        confidence_score = 0.40
        parsing_method = "fallback"
    else:
        if len(party) <= 4:
            confidence_score = 0.75
            parsing_method = "hybrid"

    cleaned_narration = raw_narration
    for token in ignored_tokens:
        cleaned_narration = cleaned_narration.replace(token, "")
    cleaned_narration = re.sub(r'[-/]{2,}', '-', cleaned_narration)
    cleaned_narration = cleaned_narration.strip("-/ ")
    
    return {
        "raw_narration": raw_narration,
        "cleaned_narration": cleaned_narration,
        "party_name": party,
        "transaction_mode": mode,
        "confidence_score": confidence_score,
        "parsing_method": parsing_method,
        "ignored_tokens": ignored_tokens
    }

# Backwards compatible wrapper for title-case and tuple format
def clean_narration(raw_text: str) -> tuple[str, str]:
    res = parse_transaction(raw_text)
    party = res["party_name"]
    # Specific short codes should remain upper/exact
    if party in ["F", "TPT", "CHQ DEPOSIT", "CHQ", "UNKNOWN", "BANK CHARGES", "SELF / CASH", "CHEQUE CLEARED", "BANK INTEREST RECEIVED"]:
        if party == "BANK CHARGES":
            return "Bank Charges", res["transaction_mode"]
        elif party == "SELF / CASH":
            return "Self / Cash", res["transaction_mode"]
        elif party == "CHEQUE CLEARED":
            return "Cheque Cleared", res["transaction_mode"]
        elif party == "BANK INTEREST RECEIVED":
            return "Bank Interest Received", res["transaction_mode"]
        return party, res["transaction_mode"]
    return party.title(), res["transaction_mode"]
