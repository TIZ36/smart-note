FROM python:3.12-slim

WORKDIR /app

# System deps for asyncpg + cryptography native wheels.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      libpq-dev \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Build context is cloud/ (see docker-compose.yml), so paths are `api/...`
# and `migrations/...`.
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/app ./app
COPY migrations ./migrations

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
