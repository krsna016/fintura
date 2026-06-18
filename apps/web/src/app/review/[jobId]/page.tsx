"use client";

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase-client';
import * as XLSX from 'xlsx';
import { Info, ArrowLeft, Home } from 'lucide-react';

const COMPANY_FORMATS: Record<number, string> = {
  1: "VLIPL YES BANK",
  2: "BFM ICICI BANK",
  3: "BFM IDFC FIRST BANK",
  4: "JSBTC ICICI BANK",
  5: "AMIT LOG ICICI BANK",
  6: "VL ICICI BANK"
};

const InfoTooltip = ({ content }: { content: string }) => {
  return (
    <span className="group relative inline-block ml-1.5 cursor-pointer align-middle select-none normal-case">
      <Info className="w-3.5 h-3.5 text-slate-400 hover:text-violet-400 transition-colors" />
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 scale-90 opacity-0 pointer-events-none group-hover:scale-100 group-hover:opacity-100 group-hover:pointer-events-auto transition-all duration-150 origin-bottom z-30">
        <span className="block rounded-lg border border-slate-800 bg-slate-950/95 p-2 text-[10px] text-slate-300 shadow-xl backdrop-blur-md leading-relaxed text-center font-normal normal-case">
          {content}
        </span>
        <span className="w-1.5 h-1.5 bg-slate-950 border-r border-b border-slate-800 absolute top-full left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-45" />
      </span>
    </span>
  );
};

interface Transaction {
  id: string;
  transaction_date: string;
  raw_narration: string;
  cleaned_party: string | null;
  transaction_mode: string | null;
  type: 'CR' | 'DR';
  amount: number;
  running_balance: number;
}

const formatTxDateOnly = (dateStr: string) => {
  if (!dateStr) return "";
  const delimiter = dateStr.includes("T") ? "T" : " ";
  return dateStr.split(delimiter)[0];
};

const formatTxTimeOnly = (dateStr: string) => {
  if (!dateStr) return "";
  const delimiter = dateStr.includes("T") ? "T" : " ";
  const parts = dateStr.split(delimiter);
  if (parts.length > 1) {
    const timePart = parts[1];
    return timePart.split(".")[0].split("+")[0].split("-")[0].trim();
  }
  return "";
};

const hasTimeComponent = (dateStr: string) => {
  const time = formatTxTimeOnly(dateStr);
  return time !== "";
};

interface Job {
  id: string;
  file_name: string;
  bank_detected: string | null;
  status: string;
  error_message: string | null;
  file_path: string;
}

export default function ReviewPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  
  // Base states
  const [job, setJob] = useState<Job | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'ALL' | 'UPI' | 'IMPS' | 'NEFT' | 'RTGS' | 'CASH' | 'CHEQUE' | 'CARD' | 'CHARGES'>('ALL');
  const [filterType, setFilterType] = useState<'ALL' | 'CR' | 'DR'>('ALL');

  // Wizard state variables
  const [selectedCompany, setSelectedCompany] = useState<number>(1);
  const [selectedType, setSelectedType] = useState<'ALL' | 'CR' | 'DR'>('ALL');
  const [narrationCol, setNarrationCol] = useState('Remarks');
  const [dateCol, setDateCol] = useState('Date');
  const [amountCol, setAmountCol] = useState('Amount');
  const [outputColName, setOutputColName] = useState('Output');
  const [sortByDate, setSortByDate] = useState(true);
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('ASC');
  const [keepOriginalCols, setKeepOriginalCols] = useState(false);
  const [activeTab, setActiveTab] = useState<'GRID' | 'PREVIEW'>('GRID');

  // Raw Statement grid states (for Mapping Required wizard)
  const [rawGrid, setRawGrid] = useState<string[][]>([]);
  const [fetchingRaw, setFetchingRaw] = useState(false);
  const [rawError, setRawError] = useState('');

  // Mapping configuration state
  const [headerRowIndex, setHeaderRowIndex] = useState<number>(0);
  const [dateColIndex, setDateColIndex] = useState<number>(0);
  const [narrationColIndex, setNarrationColIndex] = useState<number>(1);
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('single');
  const [amountColIndex, setAmountColIndex] = useState<number>(-1);
  const [typeColIndex, setTypeColIndex] = useState<number>(-1);
  const [debitColIndex, setDebitColIndex] = useState<number>(-1);
  const [creditColIndex, setCreditColIndex] = useState<number>(-1);
  const [balanceColIndex, setBalanceColIndex] = useState<number>(-1);
  
  const [isSubmittingMapping, setIsSubmittingMapping] = useState(false);
  const [mappingError, setMappingError] = useState('');

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editParty, setEditParty] = useState('');
  const [editMode, setEditMode] = useState('');

  const router = useRouter();

  // Helper date formatter
  const formatDateDDMMYYYY = (dateStr: string) => {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateStr;
  };

  // Live Output generator
  const getOutputValue = (cleanedParty: string | null, mode: string | null, dateStr: string, companyFormatOpt: number) => {
    const party = (cleanedParty || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
    const txMode = (mode || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
    const dateDDMMYYYY = formatDateDDMMYYYY(dateStr);
    const companyFormat = COMPANY_FORMATS[companyFormatOpt] || COMPANY_FORMATS[1];
    return `${party}-${txMode} ${companyFormat} ${dateDDMMYYYY}`;
  };

  // 1. Status Polling Loop
  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    const checkJobStatus = async () => {
      try {
        const { data: jobData, error } = await supabase
          .from('parsing_jobs')
          .select('*')
          .eq('id', jobId)
          .single();

        if (error) throw error;
        setJob(jobData);

        if (jobData.status === 'COMPLETED' || jobData.status === 'FAILED' || jobData.status === 'MAPPING_REQUIRED') {
          setPolling(false);
          setLoading(false);
          if (jobData.status === 'COMPLETED') {
            fetchTransactions();
          } else if (jobData.status === 'MAPPING_REQUIRED') {
            fetchRawGrid(jobData.file_path);
          }
        }
      } catch (err) {
        console.error('Error fetching job status:', err);
        setPolling(false);
        setLoading(false);
      }
    };

    if (polling) {
      checkJobStatus();
      intervalId = setInterval(checkJobStatus, 3000); // Poll every 3 seconds
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [jobId, polling]);

  const fetchTransactions = async () => {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });

    if (!error && data) {
      setTransactions(data);
    }
  };

  const fetchRawGrid = async (filePath: string) => {
    setFetchingRaw(true);
    setRawError('');
    try {
      const ext = filePath.split('.').pop() || '';
      const rawJsonPath = filePath.replace(`.${ext}`, '_raw.json');
      
      const { data, error } = await supabase.storage
        .from('statements')
        .download(rawJsonPath);
      
      if (error) throw error;
      
      const text = await data.text();
      const grid = JSON.parse(text) as string[][];
      setRawGrid(grid);
    } catch (err: any) {
      console.error("Error fetching raw grid:", err);
      setRawError(err.message || "Failed to load raw statement data.");
    } finally {
      setFetchingRaw(false);
    }
  };

  // Auto-detect mappings when header row changes or raw grid is loaded
  useEffect(() => {
    if (!rawGrid || rawGrid.length <= headerRowIndex) return;
    const headerRow = rawGrid[headerRowIndex];
    
    let dCol = 0;
    let nCol = 1;
    let aCol = -1;
    let tCol = -1;
    let drCol = -1;
    let crCol = -1;
    let bCol = -1;
    let hasDebit = false;
    let hasCredit = false;

    headerRow.forEach((cell, idx) => {
      const cleanCell = cell.toLowerCase().trim();
      if (cleanCell.includes('date')) {
        dCol = idx;
      } else if (cleanCell.includes('particular') || cleanCell.includes('description') || cleanCell.includes('narration') || cleanCell.includes('remarks') || cleanCell.includes('details') || cleanCell.includes('summary')) {
        nCol = idx;
      } else if (cleanCell.includes('debit') || cleanCell.includes('withdrawal') || cleanCell.includes('dr')) {
        drCol = idx;
        hasDebit = true;
      } else if (cleanCell.includes('credit') || cleanCell.includes('deposit') || cleanCell.includes('cr')) {
        crCol = idx;
        hasCredit = true;
      } else if (cleanCell.includes('amount') || cleanCell.includes('value')) {
        aCol = idx;
      } else if (cleanCell.includes('type')) {
        tCol = idx;
      } else if (cleanCell.includes('balance')) {
        bCol = idx;
      }
    });

    setDateColIndex(dCol);
    setNarrationColIndex(nCol);
    setBalanceColIndex(bCol);

    if (hasDebit && hasCredit) {
      setAmountMode('split');
      setDebitColIndex(drCol);
      setCreditColIndex(crCol);
      setAmountColIndex(-1);
      setTypeColIndex(-1);
    } else {
      setAmountMode('single');
      setAmountColIndex(aCol >= 0 ? aCol : (drCol >= 0 ? drCol : 2));
      setTypeColIndex(tCol);
      setDebitColIndex(-1);
      setCreditColIndex(-1);
    }
  }, [rawGrid, headerRowIndex]);

  const getMappedPreviewRows = () => {
    if (!rawGrid || rawGrid.length <= headerRowIndex + 1) return [];
    
    const previewRows: any[] = [];
    const maxPreview = Math.min(rawGrid.length, headerRowIndex + 6);
    
    for (let rIdx = headerRowIndex + 1; rIdx < maxPreview; rIdx++) {
      const row = rawGrid[rIdx];
      const maxColIdx = Math.max(
        dateColIndex,
        narrationColIndex,
        amountMode === 'single' ? amountColIndex : Math.max(debitColIndex, creditColIndex),
        balanceColIndex
      );
      
      if (row.length <= maxColIdx) continue;
      
      const dateVal = row[dateColIndex] || '';
      const narrationVal = row[narrationColIndex] || '';
      
      let amountVal = 0;
      let typeVal: 'CR' | 'DR' = 'DR';
      
      if (amountMode === 'split') {
        const dr = parseFloat((row[debitColIndex] || '0').replace(/,/g, '').replace(/[^\d.-]/g, '')) || 0;
        const cr = parseFloat((row[creditColIndex] || '0').replace(/,/g, '').replace(/[^\d.-]/g, '')) || 0;
        if (cr > 0) {
          amountVal = cr;
          typeVal = 'CR';
        } else {
          amountVal = dr;
          typeVal = 'DR';
        }
      } else {
        const amt = parseFloat((row[amountColIndex] || '0').replace(/,/g, '').replace(/[^\d.-]/g, '')) || 0;
        if (typeColIndex >= 0) {
          const tStr = (row[typeColIndex] || '').toUpperCase();
          typeVal = tStr.includes('CR') || tStr.includes('CREDIT') ? 'CR' : 'DR';
          amountVal = Math.abs(amt);
        } else {
          typeVal = amt < 0 ? 'DR' : 'CR';
          amountVal = Math.abs(amt);
        }
      }
      
      const balanceVal = balanceColIndex >= 0 
        ? (parseFloat((row[balanceColIndex] || '0').replace(/,/g, '').replace(/[^\d.-]/g, '')) || 0)
        : 0;
        
      previewRows.push({
        rowIdx: rIdx,
        date: dateVal,
        narration: narrationVal,
        amount: amountVal,
        type: typeVal,
        balance: balanceVal
      });
    }
    
    return previewRows;
  };

  const handleApplyMapping = async () => {
    setIsSubmittingMapping(true);
    setMappingError('');
    
    try {
      const parserServiceUrl = process.env.NEXT_PUBLIC_PARSER_SERVICE_URL || 'http://localhost:8000';
      const backendUrl = parserServiceUrl.startsWith('http') ? parserServiceUrl : `https://${parserServiceUrl}`;
      const response = await fetch(`${backendUrl}/apply-mapping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          file_path: job?.file_path,
          date_col: dateColIndex,
          narration_col: narrationColIndex,
          amount_col: amountMode === 'single' ? amountColIndex : -1,
          type_col: amountMode === 'single' ? typeColIndex : -1,
          debit_col: amountMode === 'split' ? debitColIndex : -1,
          credit_col: amountMode === 'split' ? creditColIndex : -1,
          balance_col: balanceColIndex,
          header_row_index: headerRowIndex
        })
      });
      
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || "Failed to submit column mapping to backend.");
      }
      
      setJob(prev => prev ? { ...prev, status: 'PROCESSING' } : null);
      setLoading(true);
      setPolling(true);
    } catch (err: any) {
      console.error("Error applying mapping:", err);
      setMappingError(err.message || "Failed to submit mapping.");
    } finally {
      setIsSubmittingMapping(false);
    }
  };

  // Start Edit
  const handleStartEdit = (tx: Transaction) => {
    setEditingId(tx.id);
    setEditParty(tx.cleaned_party || '');
    setEditMode(tx.transaction_mode || '');
  };

  // Save Edit
  const handleSave = async (id: string) => {
    try {
      const { error } = await supabase
        .from('transactions')
        .update({
          cleaned_party: editParty || null,
          transaction_mode: editMode || null
        })
        .eq('id', id);

      if (error) throw error;

      setTransactions(prev =>
        prev.map(tx => (tx.id === id ? { ...tx, cleaned_party: editParty || null, transaction_mode: editMode || null } : tx))
      );
      setEditingId(null);
    } catch (err) {
      console.error('Error saving transaction edits:', err);
    }
  };

  // 2. Client-side Exporters (Excel/CSV)
  const exportToCSV = () => {
    if (transactions.length === 0) return;

    // Header row
    const headers = keepOriginalCols 
      ? [dateCol, 'Cheque No', narrationCol, 'Type', amountCol, 'Balance', 'Transaction ID', outputColName]
      : [dateCol, 'Type', amountCol, outputColName];
    
    // Rows data
    const rows = filteredTransactions.map(tx => {
      const outputVal = getOutputValue(tx.cleaned_party, tx.transaction_mode, tx.transaction_date, selectedCompany);
      const formattedAmount = tx.amount % 1 === 0 ? Math.round(tx.amount).toString() : tx.amount.toFixed(2);
      const formattedBalance = tx.running_balance % 1 === 0 ? Math.round(tx.running_balance).toString() : tx.running_balance.toFixed(2);

      return keepOriginalCols 
        ? [
            tx.transaction_date,
            '', // Cheque No
            `"${tx.raw_narration.replace(/"/g, '""')}"`,
            tx.type,
            formattedAmount,
            formattedBalance,
            '', // Transaction ID
            `"${outputVal.replace(/"/g, '""')}"`
          ]
        : [
            tx.transaction_date,
            tx.type,
            formattedAmount,
            `"${outputVal.replace(/"/g, '""')}"`
          ];
    });

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `reconciled_${job?.file_name.replace(/\.[^/.]+$/, "")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportToExcel = () => {
    if (transactions.length === 0) return;

    // Header row
    const headers = keepOriginalCols 
      ? [dateCol, 'Cheque No', narrationCol, 'Type', amountCol, 'Balance', 'Transaction ID', outputColName]
      : [dateCol, 'Type', amountCol, outputColName];
    
    // Rows data
    const dataRows = filteredTransactions.map(tx => {
      const outputVal = getOutputValue(tx.cleaned_party, tx.transaction_mode, tx.transaction_date, selectedCompany);
      const formattedAmount = tx.amount % 1 === 0 ? Math.round(tx.amount) : Number(tx.amount.toFixed(2));
      const formattedBalance = tx.running_balance % 1 === 0 ? Math.round(tx.running_balance) : Number(tx.running_balance.toFixed(2));

      return keepOriginalCols 
        ? [
            tx.transaction_date,
            '', // Cheque No
            tx.raw_narration,
            tx.type,
            formattedAmount,
            formattedBalance,
            '', // Transaction ID
            outputVal
          ]
        : [
            tx.transaction_date,
            tx.type,
            formattedAmount,
            outputVal
          ];
    });

    const worksheetData = [headers, ...dataRows];
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Reconciled');
    
    XLSX.writeFile(workbook, `reconciled_${job?.file_name.replace(/\.[^/.]+$/, "")}.xlsx`);
  };

  // Filter Transactions based on search and selected modes/types
  const filteredTransactions = transactions
    .map((tx, originalIndex) => ({ tx, originalIndex }))
    .filter(item => {
      const tx = item.tx;
      // Step 2 filter: CR / DR / BOTH
      if (selectedType === 'CR' && tx.type !== 'CR') return false;
      if (selectedType === 'DR' && tx.type !== 'DR') return false;

      const matchesSearch = 
        tx.raw_narration.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (tx.cleaned_party || '').toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesMode = filterMode === 'ALL' || tx.transaction_mode === filterMode;
      const matchesType = filterType === 'ALL' || tx.type === filterType;

      return matchesSearch && matchesMode && matchesType;
    })
    .sort((a, b) => {
      if (!sortByDate) return 0;
      const dateA = new Date(a.tx.transaction_date).getTime();
      const dateB = new Date(b.tx.transaction_date).getTime();
      if (dateA !== dateB) {
        return sortOrder === 'ASC' ? dateA - dateB : dateB - dateA;
      }
      return sortOrder === 'ASC' ? a.originalIndex - b.originalIndex : b.originalIndex - a.originalIndex;
    })
    .map(item => item.tx);

  // Math aggregates
  const totalDebits = filteredTransactions.filter(tx => tx.type === 'DR').reduce((sum, tx) => sum + tx.amount, 0);
  const totalCredits = filteredTransactions.filter(tx => tx.type === 'CR').reduce((sum, tx) => sum + tx.amount, 0);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
          <p className="mt-4 text-sm font-semibold text-slate-200">Parsing Bank Statement...</p>
          <p className="mt-2 text-xs text-slate-500">Auto-detecting layout and cleaning narrations.</p>
        </div>
      </div>
    );
  }

  if (job?.status === 'FAILED') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 font-sans">
        <div className="w-full max-w-md rounded-2xl border border-rose-500/20 bg-rose-500/5 p-6 text-center shadow-xl backdrop-blur-md">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-500">
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-bold text-slate-100">Extraction Failed</h2>
          <p className="mt-2 text-xs text-slate-400">
            {job.error_message || 'The system could not parse the uploaded file.'}
          </p>
          <button
            onClick={() => router.push('/dashboard')}
            className="mt-6 inline-flex items-center justify-center space-x-2 w-full rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 py-2.5 text-xs font-bold text-white shadow-lg hover:brightness-110 transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
          >
            <Home className="h-3.5 w-3.5" />
            <span>Return to Dashboard</span>
          </button>
        </div>
      </div>
    );
  }

  if (job?.status === 'MAPPING_REQUIRED') {
    const headerRow = rawGrid[headerRowIndex] || [];
    const previewMappedRows = getMappedPreviewRows();
    
    return (
      <div className="min-h-screen bg-slate-950 font-sans text-slate-100 relative">
        {/* Background blobs for premium glass aesthetics */}
        <div className="absolute top-0 left-1/4 h-[500px] w-[500px] rounded-full bg-violet-600/5 blur-[100px] pointer-events-none" />
        <div className="absolute bottom-0 right-1/4 h-[500px] w-[500px] rounded-full bg-indigo-600/5 blur-[100px] pointer-events-none" />

        {/* Top Banner */}
        <header className="border-b border-slate-900 bg-slate-950/80 px-8 py-4 backdrop-blur-md relative z-10">
          <div className="mx-auto flex max-w-7xl items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={() => router.push('/dashboard')}
                className="inline-flex items-center space-x-1.5 rounded-lg border border-slate-800 bg-slate-900/50 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-all hover:bg-slate-900 hover:text-white hover:border-slate-700 cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Dashboard</span>
              </button>
              <h1 className="text-sm font-bold text-slate-200">{job?.file_name}</h1>
              <span className="rounded bg-rose-500/10 px-2.5 py-0.5 font-mono text-[10px] text-rose-400 border border-rose-500/25">
                MAPPING REQUIRED
              </span>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-8 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 relative z-10">
          {/* Left panel: Wizard config (5 cols) */}
          <section className="lg:col-span-5 space-y-6">
            <div className="rounded-2xl border border-slate-900 bg-slate-900/10 p-6 backdrop-blur-md">
              <h2 className="text-sm font-bold text-slate-200 uppercase tracking-wider">Column Mapping Wizard</h2>
              <p className="mt-1 text-xs text-slate-400">
                This bank statement structure was not recognized. Please map the columns below to parse it.
              </p>

              {mappingError && (
                <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-[11px] text-rose-400">
                  {mappingError}
                </div>
              )}

              <div className="mt-6 space-y-5">
                {/* 1. Header Row Selection */}
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center mb-1">
                    Step 1: Identify Header Row
                    <InfoTooltip content="Choose the row index that contains column headings. You can also click a row directly in the table to select it." />
                  </label>
                  <select
                    value={headerRowIndex}
                    onChange={(e) => setHeaderRowIndex(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                  >
                    {rawGrid.slice(0, 10).map((row, idx) => (
                      <option key={idx} value={idx}>
                        Row {idx}: {row.slice(0, 4).join(' | ') || '(Empty Row)'}...
                      </option>
                    ))}
                  </select>
                  <span className="text-[10px] text-slate-500 mt-1 block">
                    Select the row that contains column headings. You can also click a row in the table.
                  </span>
                </div>

                {/* 2. Column Mapping fields */}
                <div className="pt-4 border-t border-slate-900/60 space-y-4">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center">
                    Step 2: Map Data Columns
                    <InfoTooltip content="Link your bank statement's columns to expected transaction fields." />
                  </label>

                  <div>
                    <span className="text-[10px] text-slate-500 flex items-center mb-1">
                      Date Column
                      <InfoTooltip content="Select the column containing the transaction date." />
                    </span>
                    <select
                      value={dateColIndex}
                      onChange={(e) => setDateColIndex(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                    >
                      {headerRow.map((cell, idx) => (
                        <option key={idx} value={idx}>
                          Col {idx}: {cell || `(Empty Column ${idx})`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 flex items-center mb-1">
                      Narration / Description Column
                      <InfoTooltip content="Select the column containing the raw narration details." />
                    </span>
                    <select
                      value={narrationColIndex}
                      onChange={(e) => setNarrationColIndex(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                    >
                      {headerRow.map((cell, idx) => (
                        <option key={idx} value={idx}>
                          Col {idx}: {cell || `(Empty Column ${idx})`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 flex items-center mb-1">
                      Amount Format Mode
                      <InfoTooltip content="Choose whether your statement uses a single combined column for transaction amounts, or separate Credit and Debit columns." />
                    </span>
                    <div className="grid grid-cols-2 gap-2 mt-1 bg-slate-950/60 p-0.5 rounded-lg border border-slate-900">
                      <button
                        type="button"
                        onClick={() => setAmountMode('single')}
                        className={`rounded-md py-1.5 text-[10px] font-bold uppercase transition-all ${
                          amountMode === 'single'
                            ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        Single Amount Col
                      </button>
                      <button
                        type="button"
                        onClick={() => setAmountMode('split')}
                        className={`rounded-md py-1.5 text-[10px] font-bold uppercase transition-all ${
                          amountMode === 'split'
                            ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        Split Debit/Credit Cols
                      </button>
                    </div>
                  </div>

                  {amountMode === 'single' ? (
                    <>
                      <div>
                        <span className="text-[10px] text-slate-500 flex items-center mb-1">
                          Amount Column
                          <InfoTooltip content="Select the column containing the transaction value." />
                        </span>
                        <select
                          value={amountColIndex}
                          onChange={(e) => setAmountColIndex(Number(e.target.value))}
                          className="w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                        >
                          <option value={-1}>-- Select Column --</option>
                          {headerRow.map((cell, idx) => (
                            <option key={idx} value={idx}>
                              Col {idx}: {cell || `(Empty Column ${idx})`}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <span className="text-[10px] text-slate-500 flex items-center mb-1">
                          Transaction Type Col (CR/DR) - Optional
                          <InfoTooltip content="Select the column indicating Credit/Debit type (CR/DR). If none, type will be inferred from positive/negative sign." />
                        </span>
                        <select
                          value={typeColIndex}
                          onChange={(e) => setTypeColIndex(Number(e.target.value))}
                          className="w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                        >
                          <option value={-1}>-- None (Infer from +/- Sign) --</option>
                          {headerRow.map((cell, idx) => (
                            <option key={idx} value={idx}>
                              Col {idx}: {cell || `(Empty Column ${idx})`}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <span className="text-[10px] text-slate-500 flex items-center mb-1">
                          Debit Column
                          <InfoTooltip content="Select the column containing Debit/Withdrawal amounts." />
                        </span>
                        <select
                          value={debitColIndex}
                          onChange={(e) => setDebitColIndex(Number(e.target.value))}
                          className="w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                        >
                          <option value={-1}>-- Select Column --</option>
                          {headerRow.map((cell, idx) => (
                            <option key={idx} value={idx}>
                              Col {idx}: {cell || `(Empty Column ${idx})`}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <span className="text-[10px] text-slate-500 flex items-center mb-1">
                          Credit Column
                          <InfoTooltip content="Select the column containing Credit/Deposit amounts." />
                        </span>
                        <select
                          value={creditColIndex}
                          onChange={(e) => setCreditColIndex(Number(e.target.value))}
                          className="w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                        >
                          <option value={-1}>-- Select Column --</option>
                          {headerRow.map((cell, idx) => (
                            <option key={idx} value={idx}>
                              Col {idx}: {cell || `(Empty Column ${idx})`}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}

                  <div>
                    <span className="text-[10px] text-slate-500 flex items-center mb-1">
                      Running Balance Column - Optional
                      <InfoTooltip content="Select the column containing the post-transaction account balance." />
                    </span>
                    <select
                      value={balanceColIndex}
                      onChange={(e) => setBalanceColIndex(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                    >
                      <option value={-1}>-- None --</option>
                      {headerRow.map((cell, idx) => (
                        <option key={idx} value={idx}>
                          Col {idx}: {cell || `(Empty Column ${idx})`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Submit button */}
                <button
                  type="button"
                  disabled={
                    isSubmittingMapping ||
                    (amountMode === 'single' && amountColIndex === -1) ||
                    (amountMode === 'split' && (debitColIndex === -1 || creditColIndex === -1))
                  }
                  onClick={handleApplyMapping}
                  className="w-full mt-6 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 py-3 text-xs font-bold text-white shadow-lg hover:brightness-110 transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                >
                  {isSubmittingMapping ? 'Applying Mapping...' : 'Apply Column Mapping'}
                </button>
              </div>
            </div>
          </section>

          {/* Right panel: Data Grid Previews (7 cols) */}
          <section className="lg:col-span-7 space-y-6">
            {/* Raw Grid Table */}
            <div className="rounded-2xl border border-slate-900 bg-slate-900/10 p-6 backdrop-blur-md">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Raw File Preview</h2>
              <p className="text-[10px] text-slate-500 mb-4">Showing the first 10 rows. Click a row to set it as the header row.</p>
              
              <div className="overflow-x-auto rounded-xl border border-slate-900 bg-slate-950/40 max-h-[300px] overflow-y-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-900 text-slate-500 font-semibold bg-slate-950/80">
                      <th className="p-3 border-r border-slate-900 text-center w-10 sticky top-0 bg-slate-950">Row</th>
                      {headerRow.map((_, colIdx) => (
                        <th key={colIdx} className="p-3 border-r border-slate-900 sticky top-0 bg-slate-950">
                          Col {colIdx}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900">
                    {rawGrid.slice(0, 10).map((row, rIdx) => {
                      const isHeader = rIdx === headerRowIndex;
                      return (
                        <tr 
                          key={rIdx} 
                          className={`hover:bg-slate-900/20 transition-colors cursor-pointer ${isHeader ? 'bg-violet-950/30' : ''}`}
                          onClick={() => setHeaderRowIndex(rIdx)}
                        >
                          <td className={`p-3 border-r border-slate-900 text-center font-mono font-bold ${isHeader ? 'text-violet-400' : 'text-slate-500'}`}>
                            {rIdx}
                          </td>
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} className={`p-3 border-r border-slate-900 font-mono text-[11px] truncate max-w-[180px] ${isHeader ? 'text-violet-300 font-bold' : 'text-slate-400'}`} title={cell}>
                              {cell || <span className="text-slate-700 italic">empty</span>}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mapped Live Preview */}
            <div className="rounded-2xl border border-slate-900 bg-slate-900/10 p-6 backdrop-blur-md">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Live Parsed Preview</h2>
              <p className="text-[10px] text-slate-500 mb-4">Instant client-side preview of the first 5 transactions using selected mappings.</p>
              
              <div className="overflow-hidden rounded-xl border border-slate-900 bg-slate-950/40">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-900 text-slate-500 font-semibold bg-slate-950/80">
                      <th className="p-3">Source Row</th>
                      <th className="p-3">Date</th>
                      <th className="p-3">Raw Narration</th>
                      <th className="p-3">Type</th>
                      <th className="p-3 text-right">Amount</th>
                      <th className="p-3 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-900">
                    {previewMappedRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-6 text-center text-slate-600 italic">
                          Map columns to see live preview.
                        </td>
                      </tr>
                    ) : (
                      previewMappedRows.map((r, idx) => (
                        <tr key={idx} className="hover:bg-slate-900/10 transition-colors">
                          <td className="p-3 font-mono text-slate-500">Row {r.rowIdx}</td>
                          <td className="p-3 font-mono text-slate-300">{r.date}</td>
                          <td className="p-3 text-slate-400 max-w-xs truncate" title={r.narration}>{r.narration}</td>
                          <td className="p-3">
                            <span className={`font-semibold ${r.type === 'CR' ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {r.type}
                            </span>
                          </td>
                          <td className="p-3 text-right font-semibold text-slate-200">
                            ₹{r.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </td>
                          <td className="p-3 text-right text-slate-400">
                            ₹{r.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-100 relative">
      {/* Background blobs for premium glass aesthetics */}
      <div className="absolute top-0 left-1/4 h-[500px] w-[500px] rounded-full bg-violet-600/5 blur-[100px] pointer-events-none" />
      <div className="absolute bottom-0 right-1/4 h-[500px] w-[500px] rounded-full bg-indigo-600/5 blur-[100px] pointer-events-none" />

      {/* Top Banner */}
      <header className="border-b border-slate-900 bg-slate-950/80 px-8 py-4 backdrop-blur-md relative z-10">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => router.push('/dashboard')}
              className="inline-flex items-center space-x-1.5 rounded-lg border border-slate-800 bg-slate-900/50 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-all hover:bg-slate-900 hover:text-white hover:border-slate-700 cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Dashboard</span>
            </button>
            <h1 className="text-sm font-bold text-slate-200">{job?.file_name}</h1>
            <span className="rounded bg-violet-500/10 px-2.5 py-0.5 font-mono text-[10px] text-violet-400 border border-violet-500/25">
              {job?.bank_detected || 'AUTO-DETECTED'}
            </span>
          </div>

          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-1">
              <button
                onClick={exportToCSV}
                className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-2 text-xs font-bold text-slate-300 hover:bg-slate-900 hover:text-white transition-colors cursor-pointer"
              >
                Export Reconciled CSV
              </button>
              <InfoTooltip content="Downloads the current list of classified transactions as a CSV file." />
            </div>
            <div className="flex items-center space-x-1">
              <button
                onClick={exportToExcel}
                className="rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg hover:brightness-110 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
              >
                Export Reconciled Excel
              </button>
              <InfoTooltip content="Downloads the current list of classified transactions as a formatted Excel workbook." />
            </div>
          </div>
        </div>
      </header>

      {/* Main Grid Workspace */}
      <main className="mx-auto max-w-7xl px-8 py-8 flex flex-col lg:flex-row gap-8 relative z-10">
        
        {/* Left Column: Interactive Processing Wizard */}
        <aside className="w-full lg:w-[320px] shrink-0 space-y-6">
          <div className="rounded-2xl border border-slate-900 bg-slate-900/10 p-5 backdrop-blur-md">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Processing Wizard</h2>
            <p className="mt-1 text-[11px] text-slate-500">Configure company formats, mappings, and outputs deterministically.</p>

            <div className="mt-6 space-y-5">
              {/* Step 1: Select Company */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center">
                  Step 1: Company Format
                  <InfoTooltip content="Select the target accounting entity prefix format for the counterparties (e.g. VLIPL - YES BANK) used in output strings." />
                </label>
                <select
                  value={selectedCompany}
                  onChange={(e) => setSelectedCompany(Number(e.target.value))}
                  className="mt-1.5 w-full rounded-lg border border-slate-900 bg-slate-950 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
                >
                  <option value={1}>1. VLIPL - YES BANK</option>
                  <option value={2}>2. BFM - ICICI BANK</option>
                  <option value={3}>3. BFM - IDFC FIRST BANK</option>
                  <option value={4}>4. JSBTC - ICICI BANK</option>
                  <option value={5}>5. AMIT LOG - ICICI BANK</option>
                  <option value={6}>6. VL - ICICI BANK</option>
                </select>
              </div>

              {/* Step 2: Transaction Type */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center">
                  Step 2: Transaction Type
                  <InfoTooltip content="Filter transactions displayed in the grid and output sheet by Credit (CR), Debit (DR), or both." />
                </label>
                <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg border border-slate-900 bg-slate-950/60 p-0.5">
                  {(['ALL', 'CR', 'DR'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setSelectedType(type)}
                      className={`rounded-md py-1.5 text-[10px] font-bold uppercase transition-all ${
                        selectedType === type
                          ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {type === 'ALL' ? 'Both' : type}
                    </button>
                  ))}
                </div>
              </div>

              {/* Step 3: Column Mapping */}
              <div className="space-y-3 pt-1 border-t border-slate-900/60">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center">
                  Step 3: Column Mapping
                  <InfoTooltip content="Define target column headers for exporting values." />
                </label>
                
                <div>
                  <span className="text-[10px] text-slate-500 flex items-center">
                    Narration Column
                    <InfoTooltip content="Customize the header label for narration details in the export." />
                  </span>
                  <select
                    value={narrationCol}
                    onChange={(e) => setNarrationCol(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-900 bg-slate-950 px-2.5 py-1.5 text-[11px] text-slate-400 outline-none focus:border-violet-500"
                  >
                    <option value="Remarks">Remarks (default)</option>
                    <option value="Description">Description</option>
                    <option value="Narration">Narration</option>
                    <option value="Particulars">Particulars</option>
                    <option value="Transaction Details">Transaction Details</option>
                  </select>
                </div>

                <div>
                  <span className="text-[10px] text-slate-500 flex items-center">
                    Date Column
                    <InfoTooltip content="Customize the header label for dates in the export." />
                  </span>
                  <select
                    value={dateCol}
                    onChange={(e) => setDateCol(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-900 bg-slate-950 px-2.5 py-1.5 text-[11px] text-slate-400 outline-none focus:border-violet-500"
                  >
                    <option value="Date">Date (default)</option>
                    <option value="Txn Date">Txn Date</option>
                    <option value="Value Date">Value Date</option>
                  </select>
                </div>

                <div>
                  <span className="text-[10px] text-slate-500 flex items-center">
                    Amount Column
                    <InfoTooltip content="Customize the header label for amounts in the export." />
                  </span>
                  <select
                    value={amountCol}
                    onChange={(e) => setAmountCol(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-900 bg-slate-950 px-2.5 py-1.5 text-[11px] text-slate-400 outline-none focus:border-violet-500"
                  >
                    <option value="Amount">Amount (default)</option>
                    <option value="Txn Amt">Txn Amt</option>
                  </select>
                </div>

                <div>
                  <span className="text-[10px] text-slate-500 flex items-center">
                    Output Column Name
                    <InfoTooltip content="Customize the header label for the cleaned narration output column." />
                  </span>
                  <input
                    type="text"
                    value={outputColName}
                    onChange={(e) => setOutputColName(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-900 bg-slate-950 px-2.5 py-1.5 text-[11px] text-slate-300 outline-none focus:border-violet-500"
                  />
                </div>
              </div>

              {/* Step 4: Filters & Formatting */}
              <div className="space-y-3 pt-1 border-t border-slate-900/60">
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center">
                  Step 4: Filters & Formatting
                  <InfoTooltip content="Define sorting rules and structural preferences for the exports." />
                </label>
                
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-500 flex items-center">
                    Sort by Date
                    <InfoTooltip content="Order transactions chronologically in the output." />
                  </span>
                  <input
                    type="checkbox"
                    checked={sortByDate}
                    onChange={(e) => setSortByDate(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-800 bg-slate-950 accent-violet-600"
                  />
                </div>

                {sortByDate && (
                  <div>
                    <span className="text-[10px] text-slate-500 flex items-center">
                      Sort Order
                      <InfoTooltip content="Select Ascending (oldest first) or Descending (newest first) order." />
                    </span>
                    <select
                      value={sortOrder}
                      onChange={(e: any) => setSortOrder(e.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-900 bg-slate-950 px-2.5 py-1.5 text-[11px] text-slate-400 outline-none focus:border-violet-500"
                    >
                      <option value="ASC">Ascending (Oldest First)</option>
                      <option value="DESC">Descending (Newest First)</option>
                    </select>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-500 flex items-center">
                    Keep Original Columns
                    <InfoTooltip content="If checked, original columns (cheque no, raw description, balance) are kept alongside the clean output column." />
                  </span>
                  <input
                    type="checkbox"
                    checked={keepOriginalCols}
                    onChange={(e) => setKeepOriginalCols(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-800 bg-slate-950 accent-violet-600"
                  />
                </div>
              </div>

            </div>
          </div>
        </aside>

        {/* Right Column: Summaries & Transactions Grid */}
        <section className="flex-1 min-w-0 space-y-6">
          {/* Statistics Panels */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-900 bg-slate-900/10 p-4">
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Reconciled Rows</p>
              <p className="mt-1 text-xl font-black text-slate-100">{filteredTransactions.length}</p>
            </div>
            <div className="rounded-xl border border-slate-900 bg-slate-900/10 p-4">
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Debit Total (DR)</p>
              <p className="mt-1 text-xl font-black text-rose-400">₹{totalDebits.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="rounded-xl border border-slate-900 bg-slate-900/10 p-4">
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Credit Total (CR)</p>
              <p className="mt-1 text-xl font-black text-emerald-400">₹{totalCredits.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
            </div>
          </div>
          {/* Tab Selector */}
          <div className="flex border-b border-slate-900 gap-6">
            <button
              onClick={() => setActiveTab('GRID')}
              className={`pb-3 text-xs font-bold transition-all relative flex items-center ${
                activeTab === 'GRID'
                  ? 'text-violet-400 after:absolute after:bottom-0 after:left-0 after:w-full after:h-0.5 after:bg-violet-500'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Reconciliation Grid
              <InfoTooltip content="Interact with, search, filter, and manually edit classifications/modes directly." />
            </button>
            <button
              onClick={() => setActiveTab('PREVIEW')}
              className={`pb-3 text-xs font-bold transition-all relative flex items-center ${
                activeTab === 'PREVIEW'
                  ? 'text-violet-400 after:absolute after:bottom-0 after:left-0 after:w-full after:h-0.5 after:bg-violet-500'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Export Preview ({keepOriginalCols ? 'Original + ' : ''}{outputColName})
              <InfoTooltip content="Preview the exact columns and cleaned data formatting as it will appear in the downloaded file." />
            </button>
          </div>

          {activeTab === 'GRID' ? (
            <>
              {/* Table Search & Filter Bar */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="w-full max-w-sm">
                  <input
                    type="text"
                    placeholder="Search party or narration..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-lg border border-slate-900 bg-slate-900/30 px-3.5 py-1.5 text-xs text-slate-200 outline-none focus:border-violet-500/55 focus:ring-1 focus:ring-violet-500/20"
                  />
                </div>

                <div className="flex items-center space-x-2">
                  <select
                    value={filterMode}
                    onChange={(e: any) => setFilterMode(e.target.value)}
                    className="rounded-lg border border-slate-900 bg-slate-900/30 px-3 py-1.5 text-[11px] text-slate-300 outline-none"
                  >
                    <option value="ALL">All Modes</option>
                    <option value="UPI">UPI</option>
                    <option value="IMPS">IMPS</option>
                    <option value="NEFT">NEFT</option>
                    <option value="RTGS">RTGS</option>
                    <option value="CASH">CASH</option>
                    <option value="CHEQUE">CHEQUE</option>
                    <option value="CARD">CARD</option>
                    <option value="CHARGES">CHARGES</option>
                  </select>
                </div>
              </div>

              {/* Transactions Table Grid */}
              <div className="overflow-hidden rounded-xl border border-slate-900 bg-slate-900/10">
                <div className="overflow-x-auto">
                  {(() => {
                    const anyHasTime = transactions.some(tx => hasTimeComponent(tx.transaction_date));
                    return (
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-900 text-slate-500 font-semibold uppercase tracking-wider bg-slate-950/40">
                            <th className="p-4">Date</th>
                            {anyHasTime && <th className="p-4">Time</th>}
                            <th className="p-4">Raw Narration</th>
                            <th className="p-4">Extracted Counterparty</th>
                            <th className="p-4">Mode</th>
                            <th className="p-4">Type</th>
                            <th className="p-4 text-right">Amount</th>
                            <th className="p-4">Output Preview</th>
                            <th className="p-4 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-900">
                      {filteredTransactions.map((tx) => {
                        const isEditing = editingId === tx.id;
                        const outputPreview = isEditing 
                          ? getOutputValue(editParty, editMode, tx.transaction_date, selectedCompany)
                          : getOutputValue(tx.cleaned_party, tx.transaction_mode, tx.transaction_date, selectedCompany);

                        return (
                          <tr key={tx.id} className="hover:bg-slate-900/10 transition-colors">
                            <td className="p-4 font-mono text-slate-300 whitespace-nowrap">{formatTxDateOnly(tx.transaction_date)}</td>
                            {anyHasTime && (
                              <td className="p-4 font-mono text-slate-400 whitespace-nowrap">
                                {formatTxTimeOnly(tx.transaction_date) || <span className="text-slate-600">-</span>}
                              </td>
                            )}
                            <td className="p-4 text-slate-400 max-w-xs truncate" title={tx.raw_narration}>
                              {tx.raw_narration}
                            </td>
                            <td className="p-4 font-medium text-slate-200">
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={editParty}
                                  onChange={(e) => setEditParty(e.target.value)}
                                  className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-200 outline-none focus:border-violet-500"
                                />
                              ) : (
                                tx.cleaned_party || <span className="text-slate-500">Unclassified</span>
                              )}
                            </td>
                            <td className="p-4">
                              {isEditing ? (
                                <select
                                  value={editMode}
                                  onChange={(e) => setEditMode(e.target.value)}
                                  className="rounded border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-200 outline-none focus:border-violet-500"
                                >
                                  <option value="">(None/Empty)</option>
                                  <option value="NEFT">NEFT</option>
                                  <option value="RTGS">RTGS</option>
                                  <option value="IMPS">IMPS</option>
                                  <option value="UPI">UPI</option>
                                  <option value="CASH">CASH</option>
                                  <option value="CHEQUE">CHEQUE</option>
                                  <option value="CHQ">CHQ</option>
                                  <option value="CARD">CARD</option>
                                  <option value="CHARGES">CHARGES</option>
                                  <option value="OTHER">OTHER</option>
                                </select>
                              ) : tx.transaction_mode ? (
                                <span className="rounded bg-slate-800/80 px-2 py-0.5 font-mono text-[9px] text-slate-400">
                                  {tx.transaction_mode}
                                </span>
                              ) : (
                                <span className="text-slate-600">-</span>
                              )}
                            </td>
                            <td className="p-4">
                              <span className={`font-semibold ${tx.type === 'CR' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {tx.type}
                              </span>
                            </td>
                            <td className={`p-4 text-right font-semibold ${tx.type === 'CR' ? 'text-emerald-400' : 'text-slate-200'}`}>
                              ₹{tx.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </td>
                            <td className="p-4 font-mono text-[10px] text-violet-300 max-w-xs truncate" title={outputPreview}>
                              {outputPreview}
                            </td>
                            <td className="p-4 text-right">
                              {isEditing ? (
                                <div className="flex justify-end space-x-2">
                                  <button
                                    onClick={() => handleSave(tx.id)}
                                    className="rounded bg-emerald-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-emerald-500"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => setEditingId(null)}
                                    className="rounded border border-slate-800 bg-slate-900 px-2.5 py-1 text-[10px] font-semibold text-slate-300 hover:bg-slate-800"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => handleStartEdit(tx)}
                                  className="rounded border border-violet-500/30 bg-violet-500/5 px-2.5 py-1 text-[10px] font-bold text-violet-400 transition-colors hover:bg-violet-500 hover:text-white"
                                >
                                  Edit
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                    );
                  })()}
                </div>
              </div>
            </>
          ) : (
            /* Clean Export Excel sheet format preview tab */
            <div className="overflow-hidden rounded-xl border border-slate-900 bg-slate-900/10">
              <div className="overflow-x-auto">
                {(() => {
                  const anyHasTime = transactions.some(tx => hasTimeComponent(tx.transaction_date));
                  return (
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-900 text-slate-500 font-semibold uppercase tracking-wider bg-slate-950/40">
                          {keepOriginalCols ? (
                            <>
                              <th className="p-4">{dateCol}</th>
                              {anyHasTime && <th className="p-4">Time</th>}
                              <th className="p-4">Cheque No</th>
                              <th className="p-4">{narrationCol}</th>
                              <th className="p-4">Type</th>
                              <th className="p-4 text-right">{amountCol}</th>
                              <th className="p-4 text-right">Balance</th>
                              <th className="p-4">Transaction ID</th>
                              <th className="p-4">{outputColName}</th>
                            </>
                          ) : (
                            <>
                              <th className="p-4">{dateCol}</th>
                              {anyHasTime && <th className="p-4">Time</th>}
                              <th className="p-4">Type</th>
                              <th className="p-4 text-right">{amountCol}</th>
                              <th className="p-4">{outputColName}</th>
                            </>
                          )}
                        </tr>
                      </thead>
                  <tbody className="divide-y divide-slate-900">
                    {filteredTransactions.map((tx) => {
                      const outputVal = getOutputValue(tx.cleaned_party, tx.transaction_mode, tx.transaction_date, selectedCompany);
                      const formattedAmount = tx.amount % 1 === 0 ? Math.round(tx.amount).toString() : tx.amount.toFixed(2);
                      const formattedBalance = tx.running_balance % 1 === 0 ? Math.round(tx.running_balance).toString() : tx.running_balance.toFixed(2);

                      return (
                        <tr key={tx.id} className="hover:bg-slate-900/10 transition-colors">
                          {keepOriginalCols ? (
                            <>
                              <td className="p-4 font-mono text-slate-300 whitespace-nowrap">{formatTxDateOnly(tx.transaction_date)}</td>
                              {anyHasTime && (
                                <td className="p-4 font-mono text-slate-400 whitespace-nowrap">
                                  {formatTxTimeOnly(tx.transaction_date) || <span className="text-slate-600">-</span>}
                                </td>
                              )}
                              <td className="p-4 text-slate-500">-</td>
                              <td className="p-4 text-slate-400 max-w-xs truncate" title={tx.raw_narration}>{tx.raw_narration}</td>
                              <td className="p-4 font-semibold text-slate-400">{tx.type}</td>
                              <td className="p-4 text-right text-slate-200">₹{formattedAmount}</td>
                              <td className="p-4 text-right text-slate-400">₹{formattedBalance}</td>
                              <td className="p-4 text-slate-500">-</td>
                              <td className="p-4 font-mono text-violet-300 font-bold whitespace-nowrap">{outputVal}</td>
                            </>
                          ) : (
                            <>
                              <td className="p-4 font-mono text-slate-300 whitespace-nowrap">{formatTxDateOnly(tx.transaction_date)}</td>
                              {anyHasTime && (
                                <td className="p-4 font-mono text-slate-400 whitespace-nowrap">
                                  {formatTxTimeOnly(tx.transaction_date) || <span className="text-slate-600">-</span>}
                                </td>
                              )}
                              <td className="p-4 font-semibold text-slate-400">{tx.type}</td>
                              <td className="p-4 text-right text-slate-200">₹{formattedAmount}</td>
                              <td className="p-4 font-mono text-violet-300 font-bold whitespace-nowrap">{outputVal}</td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                  );
                })()}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
