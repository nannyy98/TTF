/*
  # Fix admin_accounts trigger - add missing updated_at column
  
  The trigger update_admin_accounts_updated_at tries to set updated_at,
  but the column doesn't exist.
*/

-- Add updated_at column
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT NOW();

-- Update existing rows
UPDATE admin_accounts SET updated_at = created_at WHERE updated_at IS NULL;