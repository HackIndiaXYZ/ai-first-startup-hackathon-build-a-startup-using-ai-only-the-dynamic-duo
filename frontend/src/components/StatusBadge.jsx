import './StatusBadge.css';

const STATUS_CONFIG = {
  active: { label: 'Active', className: 'badge--active' },
  expiring_soon: { label: 'Expiring Soon', className: 'badge--expiring' },
  expired: { label: 'Expired', className: 'badge--expired' },
  cancelled: { label: 'Cancelled', className: 'badge--cancelled' },
  unknown: { label: 'Unknown', className: 'badge--unknown' },
};

export default function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
  return (
    <span className={`status-badge ${config.className}`}>
      {config.label}
    </span>
  );
}
