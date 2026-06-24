# Contributing to Fintura

Thank you for contributing to Fintura! This project is structured as a monorepo consisting of:
- **`apps/web`**: Next.js (TypeScript) frontend application.
- **`apps/parser-service`**: Python (FastAPI) document processing service.

---

## Workspace Setup

### Prerequisites
- Node.js 18+ & npm
- Python 3.12+
- Docker & Docker Compose
- Supabase CLI (Optional, for database migrations)

### 1. Root Level Tasks
Clone this repository:
```bash
git clone https://github.com/krsna016/fintura.git
cd fintura
```

### 2. Frontend Development (`apps/web`)
1. Navigate to the web folder:
   ```bash
   cd apps/web
   ```
2. Install npm dependencies:
   ```bash
   npm install
   ```
3. Set up local variables:
   Copy `.env.example` to `.env.local` and fill in Supabase credentials.
4. Run the Next.js development server:
   ```bash
   npm run dev
   ```

### 3. Backend Development (`apps/parser-service`)
1. Navigate to the parser service:
   ```bash
   cd apps/parser-service
   ```
2. Create and activate a Python virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate
   ```
3. Install runtime dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Run the FastAPI service:
   ```bash
   uvicorn app.main:app --reload
   ```

---

## Docker Compose Setup
To spin up all services locally, including database dependencies, run from the root directory:
```bash
docker-compose up --build
```

---

## Coding Standards & Git Guidelines

### Branching Model
- **`main`**: Production-ready branch. Must be updated only via PRs.
- **`develop`**: Development staging branch.
- **`feature/*`**: Dedicated feature branches.
- **`fix/*`**: Bug fixes.
- **`release/*`**: Semantic releases.

### Commit Messages
We follow **Conventional Commits** formatting:
- `feat(web): add ledger billing component`
- `fix(parser): repair invalid table extraction regex`
- `docs(root): update licensing and setup logs`
- `chore(deps): bump next.js version to patch releases`

### Validation Pipelines
Before committing, ensure your code passes local syntax quality bars:
```bash
# From the root directory
make lint
make test
```
