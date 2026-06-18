.PHONY: install lint format test dev clean help

# Default targets
all: lint test

# Install all workspace dependencies
install:
	@echo "Installing frontend dependencies..."
	cd apps/web && npm install
	@echo "Setting up backend dependencies..."
	cd apps/parser-service && python3 -m venv venv && ./venv/bin/pip install --upgrade pip && ./venv/bin/pip install -r requirements.txt
	@echo "Registering pre-commit hooks..."
	pre-commit install

# Lint both frontend and backend
lint:
	@echo "Linting Next.js frontend..."
	cd apps/web && npm run lint --if-present || true
	@echo "Linting FastAPI backend..."
	cd apps/parser-service && ./venv/bin/ruff check . && ./venv/bin/mypy . --ignore-missing-imports --exclude venv

# Format both frontend and backend
format:
	@echo "Formatting Next.js frontend..."
	cd apps/web && npx prettier --write "src/**/*.{js,jsx,ts,tsx,json,css}" --ignore-path .gitignore || true
	@echo "Formatting FastAPI backend..."
	cd apps/parser-service && ./venv/bin/ruff format .

# Run test suites
test:
	@echo "Running backend unit tests..."
	cd apps/parser-service && ./venv/bin/pytest tests/

# Spin up entire development environment via Docker Compose
dev:
	docker-compose up --build

# Clean temporary build and environment files
clean:
	@echo "Cleaning up build artifacts..."
	rm -rf apps/web/.next apps/web/out apps/web/node_modules
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type d -name ".pytest_cache" -exec rm -rf {} +
	find . -type d -name ".ruff_cache" -exec rm -rf {} +
	find . -type d -name ".mypy_cache" -exec rm -rf {} +

# Display helper information
help:
	@echo "Fintura Workspace Automation Runner:"
	@echo "  install   Install dependencies for Next.js web and FastAPI parser-service"
	@echo "  lint      Verify code styling on frontend (ESLint/Prettier) and backend (Ruff/Mypy)"
	@echo "  format    Auto-format TypeScript and Python codebases"
	@echo "  test      Run Python unit test suites"
	@echo "  dev       Launch Docker Compose dev environment"
	@echo "  clean     Wipe build caches, node_modules, and python build targets"
