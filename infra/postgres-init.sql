-- Runtime role for the API. Not a superuser and not the table owner, so RLS applies.
CREATE ROLE maris_app LOGIN PASSWORD 'maris_app_dev' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE maris TO maris_app;
