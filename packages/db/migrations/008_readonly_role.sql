-- API dashboard chỉ được ĐỌC. Cưỡng chế ở tầng database chứ không phải
-- chỉ ở tầng route: một route viết sai, hoặc một lỗ hổng injection, vẫn
-- không được phép sửa danh mục của agent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockagents_ro') THEN
    CREATE ROLE stockagents_ro LOGIN PASSWORD 'readonly';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO stockagents_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO stockagents_ro;

-- Bảng tạo sau này cũng tự có quyền SELECT, và CHỈ SELECT.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO stockagents_ro;
