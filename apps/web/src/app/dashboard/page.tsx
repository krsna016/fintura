"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase-client';
import { Eye, X, Search, Download, Edit2, Check, FileText, FileSpreadsheet, TrendingUp, ShieldCheck, Mail, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';

interface Job {
  id: string;
  file_name: string;
  bank_detected: string | null;
  status: string;
  total_rows: number;
  created_at: string;
  file_path: string;
}

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

export default function DashboardPage() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  
  // Live Preview Drawer State
  const [previewJob, setPreviewJob] = useState<Job | null>(null);
  const [previewTransactions, setPreviewTransactions] = useState<Transaction[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  
  // Wizard settings inside the drawer
  const [previewSelectedCompany, setPreviewSelectedCompany] = useState<number>(1);
  const [previewSelectedType, setPreviewSelectedType] = useState<'ALL' | 'CR' | 'DR'>('ALL');
  const [previewKeepOriginalCols, setPreviewKeepOriginalCols] = useState(false);
  const [previewSearchQuery, setPreviewSearchQuery] = useState('');
  const [previewFilterMode, setPreviewFilterMode] = useState<string>('ALL');
  const [previewOutputColName, setPreviewOutputColName] = useState('Output');
  const [previewSortByDate, setPreviewSortByDate] = useState(true);
  const [previewSortOrder, setPreviewSortOrder] = useState<'ASC' | 'DESC'>('ASC');

  // Inline editing inside the drawer
  const [previewEditingId, setPreviewEditingId] = useState<string | null>(null);
  const [previewEditParty, setPreviewEditParty] = useState('');
  const [previewEditMode, setPreviewEditMode] = useState('');

  // Active module hub selection
  const [activeModule, setActiveModule] = useState<'statement' | 'invoice' | 'tax' | 'audit'>('statement');

  const router = useRouter();

  useEffect(() => {
    const fetchSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/auth/login');
        return;
      }
      setUser(session.user);

      // Fetch user profile and organization
      const { data: profileData, error: profileErr } = await supabase
        .from('profiles')
        .select('*, organizations(*)')
        .eq('id', session.user.id)
        .single();
      
      if (profileErr) {
        setErrorMsg(`Database error: ${profileErr.message} (${profileErr.details || 'No details'})`);
        console.error("Profile load error:", profileErr);
      } else {
        setProfile(profileData);
      }

      // Fetch jobs history
      const { data: jobsData } = await supabase
        .from('parsing_jobs')
        .select('*')
        .order('created_at', { ascending: false });
      
      setJobs(jobsData || []);
      setLoading(false);
    };

    fetchSession();
  }, [router]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    
    // Check file format extension
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['pdf', 'csv', 'xlsx', 'xls'].includes(ext)) {
      setErrorMsg('Invalid file format. Please upload a Digital PDF, CSV, or Excel statement.');
      return;
    }

    setUploading(true);
    setErrorMsg('');

    try {
      if (!profile) {
        setErrorMsg('Profile or Organization data not loaded. Please ensure your Supabase schema is set up and RLS policies allow reading.');
        setUploading(false);
        return;
      }
      const orgId = profile.organization_id;
      
      // 1. Create a job record in Supabase (PENDING status)
      const { data: job, error: jobErr } = await supabase
        .from('parsing_jobs')
        .insert({
          organization_id: orgId,
          file_name: file.name,
          file_path: 'pending', // Temporary path
          status: 'PENDING',
        })
        .select()
        .single();

      if (jobErr) throw jobErr;

      // 2. Upload file to Supabase Storage bucket 'statements'
      const storagePath = `${orgId}/${job.id}.${ext}`;
      const { error: storageErr } = await supabase.storage
        .from('statements')
        .upload(storagePath, file);

      if (storageErr) throw storageErr;

      // 3. Update the job path in DB
      const { error: updateErr } = await supabase
        .from('parsing_jobs')
        .update({ file_path: storagePath })
        .eq('id', job.id);

      if (updateErr) throw updateErr;

      // 4. Invoke the parsing API (Call FastAPI process endpoint directly)
      const parserServiceUrl = process.env.NEXT_PUBLIC_PARSER_SERVICE_URL || 'http://localhost:8000';
      const apiResponse = await fetch(`${parserServiceUrl}/process-statement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: job.id,
          file_path: storagePath,
        }),
      });

      if (!apiResponse.ok) {
        throw new Error('Failed to notify backend parser service.');
      }

      router.push(`/review/${job.id}`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to upload and parse statement.');
      setUploading(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    document.cookie = 'sb-access-token=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    document.cookie = 'sb-refresh-token=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    router.push('/auth/login');
  };

  const handleDeleteJob = async (job: Job, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent opening preview drawer

    const confirmDelete = window.confirm(
      `Are you sure you want to delete the processing job for "${job.file_name}"?\n\nThis will permanently delete the statement details, its source file from storage, and all extracted transactions from the database.`
    );
    if (!confirmDelete) return;

    try {
      // 1. Delete source file from Supabase Storage
      if (job.file_path && job.file_path !== 'pending') {
        const { error: storageErr } = await supabase.storage
          .from('statements')
          .remove([job.file_path]);

        if (storageErr) {
          console.warn("Storage deletion warning:", storageErr);
        }
      }

      // 2. Delete parsing job from DB (DB cascade deletes associated transactions)
      const { error: dbErr } = await supabase
        .from('parsing_jobs')
        .delete()
        .eq('id', job.id);

      if (dbErr) throw dbErr;

      // 3. Update local UI state
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      setSelectedJobIds((prev) => prev.filter((id) => id !== job.id));

      // 4. Close preview drawer if this job is currently open
      if (previewJob?.id === job.id) {
        setPreviewJob(null);
      }
    } catch (err: any) {
      console.error("Error deleting job:", err);
      alert(err.message || "Failed to delete the statement.");
    }
  };

  const handleToggleSelectJob = (jobId: string) => {
    setSelectedJobIds((prev) =>
      prev.includes(jobId)
        ? prev.filter((id) => id !== jobId)
        : [...prev, jobId]
    );
  };

  const handleToggleSelectAll = () => {
    if (jobs.length === 0) return;
    if (selectedJobIds.length === jobs.length) {
      setSelectedJobIds([]);
    } else {
      setSelectedJobIds(jobs.map((j) => j.id));
    }
  };

  const handleDeleteSelectedJobs = async () => {
    if (selectedJobIds.length === 0) return;

    const confirmDelete = window.confirm(
      `Are you sure you want to delete the ${selectedJobIds.length} selected processing jobs?\n\nThis will permanently delete the statement details, their source files from storage, and all extracted transactions from the database.`
    );
    if (!confirmDelete) return;

    try {
      const selectedJobs = jobs.filter((j) => selectedJobIds.includes(j.id));

      // 1. Delete source files from Supabase Storage
      const filePathsToDelete = selectedJobs
        .map((j) => j.file_path)
        .filter((path) => path && path !== 'pending');

      if (filePathsToDelete.length > 0) {
        const { error: storageErr } = await supabase.storage
          .from('statements')
          .remove(filePathsToDelete);

        if (storageErr) {
          console.warn("Storage bulk deletion warning:", storageErr);
        }
      }

      // 2. Delete parsing jobs from DB (DB cascade deletes associated transactions)
      const { error: dbErr } = await supabase
        .from('parsing_jobs')
        .delete()
        .in('id', selectedJobIds);

      if (dbErr) throw dbErr;

      // 3. Update local UI state
      setJobs((prev) => prev.filter((j) => !selectedJobIds.includes(j.id)));

      // 4. Close preview drawer if the open job was deleted
      if (previewJob && selectedJobIds.includes(previewJob.id)) {
        setPreviewJob(null);
      }

      // 5. Clear selection
      setSelectedJobIds([]);
    } catch (err: any) {
      console.error("Error bulk deleting jobs:", err);
      alert(err.message || "Failed to delete selected statements.");
    }
  };

  // Preview Drawer handlers
  const handleOpenPreview = (job: Job) => {
    setPreviewJob(job);
    setPreviewSelectedCompany(1);
    setPreviewSelectedType('ALL');
    setPreviewKeepOriginalCols(false);
    setPreviewSearchQuery('');
    setPreviewFilterMode('ALL');
    setPreviewOutputColName('Output');
    setPreviewSortByDate(true);
    setPreviewSortOrder('ASC');
    setPreviewEditingId(null);
    fetchPreviewTransactions(job.id);
  };

  const fetchPreviewTransactions = async (jobId: string) => {
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      setPreviewTransactions(data || []);
    } catch (err: any) {
      console.error("Error fetching preview transactions:", err);
      setPreviewError(err.message || "Failed to load transactions.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handlePreviewStartEdit = (tx: Transaction) => {
    setPreviewEditingId(tx.id);
    setPreviewEditParty(tx.cleaned_party || '');
    setPreviewEditMode(tx.transaction_mode || '');
  };

  const handlePreviewSave = async (id: string) => {
    try {
      const { error } = await supabase
        .from('transactions')
        .update({
          cleaned_party: previewEditParty || null,
          transaction_mode: previewEditMode || null
        })
        .eq('id', id);

      if (error) throw error;

      setPreviewTransactions(prev =>
        prev.map(tx => (tx.id === id ? { ...tx, cleaned_party: previewEditParty || null, transaction_mode: previewEditMode || null } : tx))
      );
      setPreviewEditingId(null);
    } catch (err: any) {
      console.error("Error saving inline edit in preview:", err);
    }
  };

  const getPreviewOutputValue = (cleanedParty: string | null, mode: string | null, dateStr: string, companyFormatOpt: number) => {
    const COMPANY_FORMATS: Record<number, string> = {
      1: "VLIPL YES BANK",
      2: "BFM ICICI BANK",
      3: "BFM IDFC FIRST BANK",
      4: "JSBTC ICICI BANK",
      5: "AMIT LOG ICICI BANK",
      6: "VL ICICI BANK"
    };

    const formatDateDDMMYYYY = (ds: string) => {
      if (!ds) return '';
      const parts = ds.split('-');
      if (parts.length === 3) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
      return ds;
    };

    const party = (cleanedParty || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
    const txMode = (mode || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
    const dateDDMMYYYY = formatDateDDMMYYYY(dateStr);
    const companyFormat = COMPANY_FORMATS[companyFormatOpt] || COMPANY_FORMATS[1];
    
    return `${party}-${txMode} ${companyFormat} ${dateDDMMYYYY}`;
  };

  const filteredPreviewTransactions = previewTransactions
    .map((tx, originalIndex) => ({ tx, originalIndex }))
    .filter(item => {
      const tx = item.tx;
      if (previewSelectedType === 'CR' && tx.type !== 'CR') return false;
      if (previewSelectedType === 'DR' && tx.type !== 'DR') return false;

      const matchesSearch = 
        tx.raw_narration.toLowerCase().includes(previewSearchQuery.toLowerCase()) ||
        (tx.cleaned_party || '').toLowerCase().includes(previewSearchQuery.toLowerCase());
      
      const matchesMode = previewFilterMode === 'ALL' || tx.transaction_mode === previewFilterMode;

      return matchesSearch && matchesMode;
    })
    .sort((a, b) => {
      if (!previewSortByDate) return 0;
      const dateA = new Date(a.tx.transaction_date).getTime();
      const dateB = new Date(b.tx.transaction_date).getTime();
      if (dateA !== dateB) {
        return previewSortOrder === 'ASC' ? dateA - dateB : dateB - dateA;
      }
      return previewSortOrder === 'ASC' ? a.originalIndex - b.originalIndex : b.originalIndex - a.originalIndex;
    })
    .map(item => item.tx);

  const exportPreviewToCSV = () => {
    if (!previewJob || previewTransactions.length === 0) return;

    const headers = previewKeepOriginalCols
      ? ['Date', 'Cheque No', 'Narration', 'Type', 'Amount', 'Balance', 'Transaction ID', previewOutputColName]
      : ['Date', 'Type', 'Amount', previewOutputColName];

    const rows = filteredPreviewTransactions.map(tx => {
      const outputVal = getPreviewOutputValue(tx.cleaned_party, tx.transaction_mode, tx.transaction_date, previewSelectedCompany);
      const formattedAmount = tx.amount % 1 === 0 ? Math.round(tx.amount).toString() : tx.amount.toFixed(2);
      const formattedBalance = tx.running_balance % 1 === 0 ? Math.round(tx.running_balance).toString() : tx.running_balance.toFixed(2);

      return previewKeepOriginalCols
        ? [
            tx.transaction_date,
            '',
            `"${tx.raw_narration.replace(/"/g, '""')}"`,
            tx.type,
            formattedAmount,
            formattedBalance,
            '',
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
    link.setAttribute('download', `reconciled_${previewJob.file_name.replace(/\.[^/.]+$/, "")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportPreviewToExcel = () => {
    if (!previewJob || previewTransactions.length === 0) return;

    const headers = previewKeepOriginalCols
      ? ['Date', 'Cheque No', 'Narration', 'Type', 'Amount', 'Balance', 'Transaction ID', previewOutputColName]
      : ['Date', 'Type', 'Amount', previewOutputColName];

    const dataRows = filteredPreviewTransactions.map(tx => {
      const outputVal = getPreviewOutputValue(tx.cleaned_party, tx.transaction_mode, tx.transaction_date, previewSelectedCompany);
      const formattedAmount = tx.amount % 1 === 0 ? Math.round(tx.amount) : Number(tx.amount.toFixed(2));
      const formattedBalance = tx.running_balance % 1 === 0 ? Math.round(tx.running_balance) : Number(tx.running_balance.toFixed(2));

      return previewKeepOriginalCols
        ? [
            tx.transaction_date,
            '',
            tx.raw_narration,
            tx.type,
            formattedAmount,
            formattedBalance,
            '',
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
    
    XLSX.writeFile(workbook, `reconciled_${previewJob.file_name.replace(/\.[^/.]+$/, "")}.xlsx`);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
          <p className="mt-4 text-sm font-medium">Loading Dashboard...</p>
          {errorMsg && (
            <p className="mt-4 text-xs text-rose-400 max-w-sm rounded border border-rose-500/20 bg-rose-500/5 p-3 leading-relaxed">
              {errorMsg}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-100 relative overflow-x-hidden">
      {/* Background blobs */}
      <div className="absolute top-0 left-1/4 h-[500px] w-[500px] rounded-full bg-violet-600/5 blur-[100px]" />
      <div className="absolute bottom-0 right-1/4 h-[500px] w-[500px] rounded-full bg-indigo-600/5 blur-[100px]" />

      {/* Navbar */}
      <nav className="border-b border-slate-900 bg-slate-950/80 px-8 py-4 backdrop-blur-md relative z-20">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center space-x-3">
            <img src="/logo.png" alt="Fintura Logo" className="h-8 w-8 rounded-lg border border-slate-800 bg-slate-950 p-0.5" />
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-xl font-black tracking-wider text-transparent">
              Fintura
            </span>
            <span className="hidden rounded-full bg-slate-900 px-2.5 py-0.5 text-xs font-semibold text-slate-400 sm:inline-block">
              {profile?.organizations?.name}
            </span>
          </div>

          <div className="flex items-center space-x-4">
            <span className="text-xs text-slate-400">{user?.email}</span>
            <button
              onClick={handleLogout}
              className="rounded-lg border border-slate-800 bg-slate-900/50 px-3.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-900 hover:text-white"
            >
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      {/* Main Body */}
      <main className="mx-auto max-w-7xl px-8 py-10 relative z-10">
        
        {/* Module Selector Grid */}
        <div className="mb-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {/* Module 1: Statement Parser */}
          <div 
            onClick={() => setActiveModule('statement')}
            className={`cursor-pointer rounded-2xl border p-5 shadow-xl backdrop-blur-md transition-all duration-200 relative overflow-hidden ${
              activeModule === 'statement'
                ? 'border-violet-500/40 bg-violet-950/10 hover:border-violet-500/60'
                : 'border-slate-800 bg-slate-900/20 hover:border-slate-700/80 hover:bg-slate-900/30'
            }`}
          >
            {/* Glowing active indicator */}
            {activeModule === 'statement' && (
              <div className="absolute top-0 right-0 h-1.5 w-12 bg-gradient-to-r from-violet-500 to-indigo-500 rounded-bl" />
            )}
            <div className="flex items-center justify-between">
              <span className="rounded-lg bg-violet-500/10 p-2.5 text-violet-400 border border-violet-500/25">
                <FileText className="w-5 h-5" />
              </span>
              <span className="rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                ACTIVE
              </span>
            </div>
            <h3 className="mt-4 text-sm font-bold text-slate-100">Statement Reconciler</h3>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Upload PDF/Excel statements to clean narratives, classify counterparties, and format entries.
            </p>
          </div>

          {/* Module 2: Invoice OCR */}
          <div 
            onClick={() => setActiveModule('invoice')}
            className={`cursor-pointer rounded-2xl border p-5 shadow-xl backdrop-blur-md transition-all duration-200 relative overflow-hidden ${
              activeModule === 'invoice'
                ? 'border-violet-500/40 bg-violet-950/10 hover:border-violet-500/60'
                : 'border-slate-800 bg-slate-900/20 hover:border-slate-700/80 hover:bg-slate-900/30'
            }`}
          >
            {/* Glowing active indicator */}
            {activeModule === 'invoice' && (
              <div className="absolute top-0 right-0 h-1.5 w-12 bg-gradient-to-r from-violet-500 to-indigo-500 rounded-bl" />
            )}
            <div className="flex items-center justify-between">
              <span className="rounded-lg bg-indigo-500/10 p-2.5 text-indigo-400 border border-indigo-500/25">
                <FileSpreadsheet className="w-5 h-5" />
              </span>
              <span className="rounded-full bg-slate-800 border border-slate-700 px-2 py-0.5 text-[10px] font-bold text-slate-400">
                UPCOMING
              </span>
            </div>
            <h3 className="mt-4 text-sm font-bold text-slate-200">Invoice OCR Extractor</h3>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Extract line items, tax schedules, vendor terms, and metadata from scanned invoices.
            </p>
          </div>

          {/* Module 3: GST & Tax Hub */}
          <div 
            onClick={() => setActiveModule('tax')}
            className={`cursor-pointer rounded-2xl border p-5 shadow-xl backdrop-blur-md transition-all duration-200 relative overflow-hidden ${
              activeModule === 'tax'
                ? 'border-violet-500/40 bg-violet-950/10 hover:border-violet-500/60'
                : 'border-slate-800 bg-slate-900/20 hover:border-slate-700/80 hover:bg-slate-900/30'
            }`}
          >
            {/* Glowing active indicator */}
            {activeModule === 'tax' && (
              <div className="absolute top-0 right-0 h-1.5 w-12 bg-gradient-to-r from-violet-500 to-indigo-500 rounded-bl" />
            )}
            <div className="flex items-center justify-between">
              <span className="rounded-lg bg-pink-500/10 p-2.5 text-pink-400 border border-pink-500/25">
                <TrendingUp className="w-5 h-5" />
              </span>
              <span className="rounded-full bg-slate-800 border border-slate-700 px-2 py-0.5 text-[10px] font-bold text-slate-400">
                UPCOMING
              </span>
            </div>
            <h3 className="mt-4 text-sm font-bold text-slate-200">GST & Tax Audit</h3>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Auto-generate tax schedules and audits by cross-referencing statement history with tax files.
            </p>
          </div>

          {/* Module 4: Compliance */}
          <div 
            onClick={() => setActiveModule('audit')}
            className={`cursor-pointer rounded-2xl border p-5 shadow-xl backdrop-blur-md transition-all duration-200 relative overflow-hidden ${
              activeModule === 'audit'
                ? 'border-violet-500/40 bg-violet-950/10 hover:border-violet-500/60'
                : 'border-slate-800 bg-slate-900/20 hover:border-slate-700/80 hover:bg-slate-900/30'
            }`}
          >
            {/* Glowing active indicator */}
            {activeModule === 'audit' && (
              <div className="absolute top-0 right-0 h-1.5 w-12 bg-gradient-to-r from-violet-500 to-indigo-500 rounded-bl" />
            )}
            <div className="flex items-center justify-between">
              <span className="rounded-lg bg-cyan-500/10 p-2.5 text-cyan-400 border border-cyan-500/25">
                <ShieldCheck className="w-5 h-5" />
              </span>
              <span className="rounded-full bg-slate-800 border border-slate-700 px-2 py-0.5 text-[10px] font-bold text-slate-400">
                UPCOMING
              </span>
            </div>
            <h3 className="mt-4 text-sm font-bold text-slate-200">Ledger Compliance</h3>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Scan ledger records for anomalies, double-payments, vendor frauds, and non-compliance flags.
            </p>
          </div>
        </div>

        <div className="grid gap-10 lg:grid-cols-3">
          
          {/* File Upload Zone or Upcoming Module Details */}
          <div className="lg:col-span-1">
            {activeModule === 'statement' ? (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-6 shadow-xl backdrop-blur-md">
                <h2 className="text-lg font-bold text-slate-200">Ingest Statement</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Upload a digital PDF, Excel, or CSV statement from ICICI, YES Bank, or IDFC First.
                </p>

                {/* Upload Box */}
                <div className="mt-6">
                  <label className="flex h-48 w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-slate-700/80 bg-slate-950/40 transition-colors hover:bg-slate-950/80">
                    <div className="flex flex-col items-center justify-center pb-6 pt-5">
                      <svg className="mb-4 h-8 w-8 text-slate-500" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 16">
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137 5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2"/>
                      </svg>
                      <p className="mb-2 text-xs font-semibold text-slate-400">
                        {uploading ? 'Processing File...' : 'Drag and drop or Click'}
                      </p>
                      <p className="text-[10px] text-slate-500">PDF, XLS, XLSX, CSV (Max 25MB)</p>
                    </div>
                    <input
                      type="file"
                      className="hidden"
                      disabled={uploading}
                      onChange={handleFileUpload}
                      accept=".pdf,.csv,.xlsx,.xls"
                    />
                  </label>
                </div>

                {errorMsg && (
                  <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-[11px] text-rose-400">
                    {errorMsg}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-6 shadow-xl backdrop-blur-md h-full flex flex-col justify-between">
                <div>
                  <span className="inline-block rounded-lg bg-violet-500/10 p-2.5 text-violet-400 border border-violet-500/25 mb-4">
                    {activeModule === 'invoice' && <FileSpreadsheet className="w-6 h-6" />}
                    {activeModule === 'tax' && <TrendingUp className="w-6 h-6" />}
                    {activeModule === 'audit' && <ShieldCheck className="w-6 h-6" />}
                  </span>
                  <h2 className="text-lg font-bold text-slate-200">
                    {activeModule === 'invoice' && 'Invoice OCR Engine'}
                    {activeModule === 'tax' && 'Tax Intelligence Engine'}
                    {activeModule === 'audit' && 'Compliance Ledger Auditor'}
                  </h2>
                  <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                    {activeModule === 'invoice' && 'Process vendor receipts and invoices automatically. Extract line items, tax figures, PO numbers, and match them with ledger entries.'}
                    {activeModule === 'tax' && 'Auto-calculate input tax credits (ITC), generate draft returns, and flags discrepancies between statement items and tax documents.'}
                    {activeModule === 'audit' && 'Run machine learning audits on transaction profiles to detect duplicate bookings, compliance risks, and payment anomalies.'}
                  </p>
                  
                  <div className="mt-6 border-t border-slate-900/80 pt-6">
                    <span className="text-[10px] font-bold text-violet-400 uppercase tracking-wider block mb-2">Key Capabilities</span>
                    <ul className="space-y-2 text-[11px] text-slate-400">
                      {activeModule === 'invoice' && (
                        <>
                          <li className="flex items-center gap-2">✓ AI Layout-agnostic OCR extraction</li>
                          <li className="flex items-center gap-2">✓ Line-item split-up classification</li>
                          <li className="flex items-center gap-2">✓ Purchase Order double-verification</li>
                        </>
                      )}
                      {activeModule === 'tax' && (
                        <>
                          <li className="flex items-center gap-2">✓ Automated GST reconciliation</li>
                          <li className="flex items-center gap-2">✓ Tax ledger mismatch checks</li>
                          <li className="flex items-center gap-2">✓ Real-time input credit tracking</li>
                        </>
                      )}
                      {activeModule === 'audit' && (
                        <>
                          <li className="flex items-center gap-2">✓ Duplicate invoice risk detection</li>
                          <li className="flex items-center gap-2">✓ Entity verification scan</li>
                          <li className="flex items-center gap-2">✓ Compliance benchmark alerts</li>
                        </>
                      )}
                    </ul>
                  </div>
                </div>
                
                <div className="mt-8">
                  <button
                    type="button"
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 py-2.5 text-xs font-bold text-white shadow-lg hover:brightness-110 transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                  >
                    <Mail className="w-3.5 h-3.5" />
                    Join the Beta Waitlist
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Processing History List */}
          <div className="lg:col-span-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/20 p-6 shadow-xl backdrop-blur-md">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center space-x-3">
                  <h2 className="text-lg font-bold text-slate-200">Processing History</h2>
                  <span className="rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs text-violet-400">
                    {jobs.length} Statements
                  </span>
                </div>
                {selectedJobIds.length > 0 && (
                  <button
                    onClick={handleDeleteSelectedJobs}
                    className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-bold text-rose-400 hover:bg-rose-500/20 hover:text-rose-300 transition-all cursor-pointer shadow-lg"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Selected ({selectedJobIds.length})
                  </button>
                )}
              </div>

              {jobs.length === 0 ? (
                <div className="mt-12 text-center text-slate-500">
                  <p className="text-sm">No bank statements uploaded yet.</p>
                  <p className="mt-1 text-xs">Your processed uploads will appear here.</p>
                </div>
              ) : (
                <div className="mt-6 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500 font-semibold uppercase tracking-wider">
                        <th className="pb-3 w-8">
                          <input
                            type="checkbox"
                            checked={jobs.length > 0 && selectedJobIds.length === jobs.length}
                            onChange={handleToggleSelectAll}
                            className="rounded border-slate-800 bg-slate-950 text-violet-600 focus:ring-violet-500 focus:ring-offset-slate-950 h-3.5 w-3.5 cursor-pointer accent-violet-600"
                          />
                        </th>
                        <th className="pb-3">File Name</th>
                        <th className="pb-3">Bank Detected</th>
                        <th className="pb-3">Status</th>
                        <th className="pb-3">Rows</th>
                        <th className="pb-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-900">
                      {jobs.map((job) => (
                        <tr key={job.id} className="group hover:bg-slate-900/20">
                          <td className="py-4">
                            <input
                              type="checkbox"
                              checked={selectedJobIds.includes(job.id)}
                              onChange={() => handleToggleSelectJob(job.id)}
                              onClick={(e) => e.stopPropagation()} // Avoid triggering row events
                              className="rounded border-slate-800 bg-slate-950 text-violet-600 focus:ring-violet-500 focus:ring-offset-slate-950 h-3.5 w-3.5 cursor-pointer accent-violet-600"
                            />
                          </td>
                          <td className="py-4 font-medium text-slate-200">{job.file_name}</td>
                          <td className="py-4">
                            {job.bank_detected ? (
                              <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px]">
                                {job.bank_detected}
                              </span>
                            ) : (
                              <span className="text-slate-500">-</span>
                            )}
                          </td>
                          <td className="py-4">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              job.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-400' :
                              job.status === 'FAILED' ? 'bg-rose-500/10 text-rose-400' :
                              'bg-amber-500/10 text-amber-400 animate-pulse'
                            }`}>
                              {job.status}
                            </span>
                          </td>
                          <td className="py-4 text-slate-300">{job.total_rows || '-'}</td>
                          <td className="py-4 text-right flex items-center justify-end space-x-2">
                            {job.status === 'COMPLETED' && (
                              <button
                                onClick={() => handleOpenPreview(job)}
                                className="inline-flex items-center space-x-1.5 rounded-lg border border-slate-800 bg-slate-900/50 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:border-violet-500/40 hover:bg-violet-600/10 hover:text-violet-400"
                                title="Live Preview"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                <span>Preview</span>
                              </button>
                            )}
                            <button
                              onClick={() => router.push(`/review/${job.id}`)}
                              className="rounded-lg bg-slate-800 px-3.5 py-1 text-xs font-semibold text-slate-300 transition-colors group-hover:bg-violet-600 group-hover:text-white group-hover:border-violet-500"
                            >
                              View
                            </button>
                            <button
                              onClick={(e) => handleDeleteJob(job, e)}
                              className="inline-flex items-center space-x-1 rounded-lg border border-slate-800 bg-slate-900/50 p-1 text-xs font-semibold text-rose-400 transition-colors hover:border-rose-500/40 hover:bg-rose-600/10 hover:text-rose-300 cursor-pointer"
                              title="Delete Statement"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

        </div>
      </main>

      {/* Sliding Side Preview Drawer */}
      {previewJob && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm transition-opacity"
            onClick={() => setPreviewJob(null)}
          />

          {/* Drawer Container */}
          <div className="relative w-full max-w-4xl bg-slate-950/95 border-l border-slate-900/80 h-full flex flex-col shadow-2xl z-10 backdrop-blur-xl animate-in slide-in-from-right duration-300">
            {/* Header */}
            <div className="border-b border-slate-900 px-6 py-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-200 flex items-center space-x-2">
                  <span>Live Preview:</span>
                  <span className="text-violet-400 font-mono text-[11px] truncate max-w-xs">{previewJob.file_name}</span>
                </h3>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  Bank: <span className="text-slate-400 font-bold">{previewJob.bank_detected || 'AUTO-DETECTED'}</span> | 
                  Total Rows: <span className="text-slate-400 font-bold">{previewTransactions.length}</span>
                </p>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={exportPreviewToCSV}
                  disabled={previewLoading || previewTransactions.length === 0}
                  className="inline-flex items-center space-x-1.5 rounded-lg border border-slate-800 bg-slate-900/50 px-3.5 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-900 hover:text-white"
                  title="Download CSV"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download CSV</span>
                </button>
                <button
                  onClick={exportPreviewToExcel}
                  disabled={previewLoading || previewTransactions.length === 0}
                  className="inline-flex items-center space-x-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-lg hover:brightness-110 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
                  title="Download Excel"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download Excel</span>
                </button>
                <button
                  onClick={() => setPreviewJob(null)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-900 hover:text-white transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Split Content: Sidebar controls + Table Grid */}
            <div className="flex-1 flex overflow-hidden">
              {/* Left sidebar: Configuration controls */}
              <div className="w-64 border-r border-slate-900 p-5 space-y-5 overflow-y-auto bg-slate-950/40">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Settings Wizard</h4>
                
                {/* Format selection */}
                <div>
                  <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Step 1: Company Format</label>
                  <select
                    value={previewSelectedCompany}
                    onChange={(e) => setPreviewSelectedCompany(Number(e.target.value))}
                    className="mt-1 w-full rounded-md border border-slate-900 bg-slate-900/30 px-2.5 py-1.5 text-[11px] text-slate-300 outline-none focus:border-violet-500"
                  >
                    <option value={1}>1. VLIPL - YES BANK</option>
                    <option value={2}>2. BFM - ICICI BANK</option>
                    <option value={3}>3. BFM - IDFC FIRST BANK</option>
                    <option value={4}>4. JSBTC - ICICI BANK</option>
                    <option value={5}>5. AMIT LOG - ICICI BANK</option>
                    <option value={6}>6. VL - ICICI BANK</option>
                  </select>
                </div>

                {/* Filter CR / DR / BOTH */}
                <div>
                  <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Step 2: Transaction Type</label>
                  <div className="mt-1.5 grid grid-cols-3 gap-0.5 rounded-lg border border-slate-900 bg-slate-950 p-0.5">
                    {(['ALL', 'CR', 'DR'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setPreviewSelectedType(type)}
                        className={`rounded py-1 text-[9px] font-bold uppercase transition-all ${
                          previewSelectedType === type
                            ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        {type === 'ALL' ? 'Both' : type}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Output Col Rename */}
                <div>
                  <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Step 3: Output Column</label>
                  <input
                    type="text"
                    value={previewOutputColName}
                    onChange={(e) => setPreviewOutputColName(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-900 bg-slate-900/30 px-2.5 py-1.5 text-[11px] text-slate-300 outline-none focus:border-violet-500"
                  />
                </div>

                {/* Date Sort & Layout */}
                <div className="space-y-3 pt-4 border-t border-slate-900/60">
                  <label className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Step 4: Filters & Layout</label>
                  
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-500">Sort by Date</span>
                    <input
                      type="checkbox"
                      checked={previewSortByDate}
                      onChange={(e) => setPreviewSortByDate(e.target.checked)}
                      className="h-3 w-3 rounded border-slate-800 bg-slate-950 accent-violet-600"
                    />
                  </div>

                  {previewSortByDate && (
                    <div>
                      <span className="text-[9px] text-slate-500">Sort Order</span>
                      <select
                        value={previewSortOrder}
                        onChange={(e: any) => setPreviewSortOrder(e.target.value)}
                        className="mt-1 w-full rounded-md border border-slate-900 bg-slate-900/30 px-2 py-1 text-[10px] text-slate-400 outline-none focus:border-violet-500"
                      >
                        <option value="ASC">Oldest First</option>
                        <option value="DESC">Newest First</option>
                      </select>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-slate-500">Keep Original Columns</span>
                    <input
                      type="checkbox"
                      checked={previewKeepOriginalCols}
                      onChange={(e) => setPreviewKeepOriginalCols(e.target.checked)}
                      className="h-3 w-3 rounded border-slate-800 bg-slate-950 accent-violet-600"
                    />
                  </div>
                </div>

                {/* View Details Redirect */}
                <div className="pt-4 border-t border-slate-900/60 text-center">
                  <button
                    onClick={() => router.push(`/review/${previewJob.id}`)}
                    className="w-full text-center text-[10px] font-bold text-violet-400 hover:text-violet-300 transition-colors py-1.5 border border-violet-500/20 rounded hover:bg-violet-500/5"
                  >
                    Open Full Review Editor &rarr;
                  </button>
                </div>
              </div>

              {/* Right panel: Search and Spreadsheet Grid */}
              <div className="flex-1 flex flex-col p-6 overflow-hidden">
                {/* Search Bar inside Drawer */}
                <div className="flex items-center space-x-3 mb-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
                    <input
                      type="text"
                      placeholder="Search counterparty or narration..."
                      value={previewSearchQuery}
                      onChange={(e) => setPreviewSearchQuery(e.target.value)}
                      className="w-full rounded-lg border border-slate-900 bg-slate-900/30 pl-9 pr-4 py-1.5 text-xs text-slate-200 outline-none focus:border-violet-500/55 focus:ring-1 focus:ring-violet-500/20"
                    />
                  </div>
                  <select
                    value={previewFilterMode}
                    onChange={(e: any) => setPreviewFilterMode(e.target.value)}
                    className="rounded-lg border border-slate-900 bg-slate-900/30 px-3 py-1.5 text-[11px] text-slate-300 outline-none"
                  >
                    <option value="ALL">All Modes</option>
                    <option value="UPI">UPI</option>
                    <option value="IMPS">IMPS</option>
                    <option value="NEFT">NEFT</option>
                    <option value="RTGS">RTGS</option>
                    <option value="CASH">CASH</option>
                    <option value="CHEQUE">CHEQUE</option>
                  </select>
                </div>

                {/* Loader / Content */}
                {previewLoading ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-violet-500 border-t-transparent mb-3" />
                    <p className="text-xs">Loading transaction rows...</p>
                  </div>
                ) : previewError ? (
                  <div className="flex-1 flex items-center justify-center text-rose-400 text-xs">
                    {previewError}
                  </div>
                ) : filteredPreviewTransactions.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-slate-600 text-xs">
                    <p>No matching transactions found.</p>
                  </div>
                ) : (
                  <div className="flex-1 overflow-auto border border-slate-900 rounded-xl bg-slate-950/40">
                    {(() => {
                      const anyPreviewHasTime = previewTransactions.some(tx => hasTimeComponent(tx.transaction_date));
                      return (
                        <table className="w-full text-left text-[11px]">
                          <thead>
                            <tr className="border-b border-slate-900 text-slate-500 font-semibold uppercase tracking-wider bg-slate-950/60 sticky top-0 z-20">
                              {previewKeepOriginalCols ? (
                                <>
                                  <th className="p-3">Date</th>
                                  {anyPreviewHasTime && <th className="p-3">Time</th>}
                                  <th className="p-3">Narration</th>
                                  <th className="p-3">Type</th>
                                  <th className="p-3 text-right">Amount</th>
                                  <th className="p-3 text-right">Balance</th>
                                  <th className="p-3">{previewOutputColName}</th>
                                  <th className="p-3 text-right">Action</th>
                                </>
                              ) : (
                                <>
                                  <th className="p-3">Date</th>
                                  {anyPreviewHasTime && <th className="p-3">Time</th>}
                                  <th className="p-3">Type</th>
                                  <th className="p-3 text-right">Amount</th>
                                  <th className="p-3">{previewOutputColName}</th>
                                  <th className="p-3 text-right">Action</th>
                                </>
                              )}
                            </tr>
                          </thead>
                      <tbody className="divide-y divide-slate-900">
                        {filteredPreviewTransactions.map((tx) => {
                          const isEditing = previewEditingId === tx.id;
                          const outputPreview = isEditing 
                            ? getPreviewOutputValue(previewEditParty, previewEditMode, tx.transaction_date, previewSelectedCompany)
                            : getPreviewOutputValue(tx.cleaned_party, tx.transaction_mode, tx.transaction_date, previewSelectedCompany);
                          
                          const formattedAmount = tx.amount % 1 === 0 ? Math.round(tx.amount).toString() : tx.amount.toFixed(2);
                          const formattedBalance = tx.running_balance % 1 === 0 ? Math.round(tx.running_balance).toString() : tx.running_balance.toFixed(2);

                          return (
                            <tr key={tx.id} className="hover:bg-slate-900/10 transition-colors">
                              {previewKeepOriginalCols ? (
                                <>
                                  <td className="p-3 font-mono text-slate-300 whitespace-nowrap">{formatTxDateOnly(tx.transaction_date)}</td>
                                  {anyPreviewHasTime && (
                                    <td className="p-3 font-mono text-slate-400 whitespace-nowrap">
                                      {formatTxTimeOnly(tx.transaction_date) || <span className="text-slate-600">-</span>}
                                    </td>
                                  )}
                                  <td className="p-3 text-slate-400 max-w-xs truncate" title={tx.raw_narration}>
                                    {isEditing ? (
                                      <div className="space-y-1.5">
                                        <div className="flex items-center space-x-1">
                                          <span className="text-[9px] text-slate-500">Party:</span>
                                          <input
                                            type="text"
                                            value={previewEditParty}
                                            onChange={(e) => setPreviewEditParty(e.target.value)}
                                            className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[10px] text-slate-200 outline-none focus:border-violet-500"
                                          />
                                        </div>
                                        <div className="flex items-center space-x-1">
                                          <span className="text-[9px] text-slate-500">Mode:</span>
                                          <select
                                            value={previewEditMode}
                                            onChange={(e) => setPreviewEditMode(e.target.value)}
                                            className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[10px] text-slate-200 outline-none focus:border-violet-500"
                                          >
                                            <option value="">(None)</option>
                                            <option value="NEFT">NEFT</option>
                                            <option value="RTGS">RTGS</option>
                                            <option value="IMPS">IMPS</option>
                                            <option value="UPI">UPI</option>
                                            <option value="CASH">CASH</option>
                                            <option value="CHEQUE">CHEQUE</option>
                                          </select>
                                        </div>
                                      </div>
                                    ) : (
                                      <span className="block truncate max-w-[150px]">{tx.raw_narration}</span>
                                    )}
                                  </td>
                                  <td className="p-3">
                                    <span className={tx.type === 'CR' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                                      {tx.type}
                                    </span>
                                  </td>
                                  <td className="p-3 text-right font-mono text-slate-200">₹{formattedAmount}</td>
                                  <td className="p-3 text-right font-mono text-slate-400">₹{formattedBalance}</td>
                                  <td className="p-3 font-mono text-[9px] text-violet-300 font-bold max-w-xs truncate" title={outputPreview}>
                                    {outputPreview}
                                  </td>
                                  <td className="p-3 text-right">
                                    {isEditing ? (
                                      <div className="flex items-center justify-end space-x-1">
                                        <button
                                          onClick={() => handlePreviewSave(tx.id)}
                                          className="p-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white"
                                        >
                                          <Check className="h-3 w-3" />
                                        </button>
                                        <button
                                          onClick={() => setPreviewEditingId(null)}
                                          className="p-1 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-white"
                                        >
                                          <X className="h-3 w-3" />
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={() => handlePreviewStartEdit(tx)}
                                        className="p-1 rounded hover:bg-slate-900 text-slate-400 hover:text-violet-400 transition-colors"
                                        title="Edit Counterparty/Mode"
                                      >
                                        <Edit2 className="h-3 w-3" />
                                      </button>
                                    )}
                                  </td>
                                </>
                              ) : (
                                <>
                                  <td className="p-3 font-mono text-slate-300 whitespace-nowrap">{formatTxDateOnly(tx.transaction_date)}</td>
                                  {anyPreviewHasTime && (
                                    <td className="p-3 font-mono text-slate-400 whitespace-nowrap">
                                      {formatTxTimeOnly(tx.transaction_date) || <span className="text-slate-600">-</span>}
                                    </td>
                                  )}
                                  <td className="p-3">
                                    <span className={tx.type === 'CR' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                                      {tx.type}
                                    </span>
                                  </td>
                                  <td className="p-3 text-right font-mono text-slate-200">₹{formattedAmount}</td>
                                  <td className="p-3 font-mono text-[9px] text-violet-300 font-bold max-w-xs truncate" title={outputPreview}>
                                    {isEditing ? (
                                      <div className="space-y-1">
                                        <div className="flex items-center space-x-1">
                                          <span className="text-[8px] text-slate-500">Party:</span>
                                          <input
                                            type="text"
                                            value={previewEditParty}
                                            onChange={(e) => setPreviewEditParty(e.target.value)}
                                            className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-[9px] text-slate-200 outline-none"
                                          />
                                        </div>
                                        <div className="flex items-center space-x-1">
                                          <span className="text-[8px] text-slate-500">Mode:</span>
                                          <select
                                            value={previewEditMode}
                                            onChange={(e) => setPreviewEditMode(e.target.value)}
                                            className="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 text-[9px] text-slate-200 outline-none"
                                          >
                                            <option value="">(None)</option>
                                            <option value="NEFT">NEFT</option>
                                            <option value="RTGS">RTGS</option>
                                            <option value="IMPS">IMPS</option>
                                            <option value="UPI">UPI</option>
                                            <option value="CASH">CASH</option>
                                            <option value="CHEQUE">CHEQUE</option>
                                          </select>
                                        </div>
                                      </div>
                                    ) : (
                                      outputPreview
                                    )}
                                  </td>
                                  <td className="p-3 text-right">
                                    {isEditing ? (
                                      <div className="flex items-center justify-end space-x-1">
                                        <button
                                          onClick={() => handlePreviewSave(tx.id)}
                                          className="p-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white"
                                        >
                                          <Check className="h-3 w-3" />
                                        </button>
                                        <button
                                          onClick={() => setPreviewEditingId(null)}
                                          className="p-1 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-white"
                                        >
                                          <X className="h-3 w-3" />
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={() => handlePreviewStartEdit(tx)}
                                        className="p-1 rounded hover:bg-slate-900 text-slate-400 hover:text-violet-400 transition-colors"
                                        title="Edit Counterparty/Mode"
                                      >
                                        <Edit2 className="h-3 w-3" />
                                      </button>
                                    )}
                                  </td>
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
                )}
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
