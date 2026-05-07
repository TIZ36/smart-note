# SmartNote Cloud — Log Query Panel
#
# Standalone read-only viewer for pipeline_events. Talks to cloud-api
# /v1/logs endpoints; opens at PANEL_PORT (default 8090) in the browser.

FROM python:3.12-slim

WORKDIR /app

# Pin to keep image stable; bump together when cloud-api's httpx bumps
RUN pip install --no-cache-dir \
    "fastapi==0.115.0" \
    "uvicorn[standard]==0.30.6" \
    "asyncpg==0.29.0"

COPY app /app/app
COPY static /app/static

ENV PYTHONUNBUFFERED=1
ENV PANEL_PORT=8090

EXPOSE 8090

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
