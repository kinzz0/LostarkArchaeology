export default function StatusBar({ status }) {
  const statusStyles = {
    idle: 'bg-gray-700 text-gray-300',
    loading: 'bg-yellow-900/50 text-yellow-300',
    success: 'bg-green-900/50 text-green-300',
    error: 'bg-red-900/50 text-red-300',
  }

  const statusIcons = {
    idle: '⏸️',
    loading: '⏳',
    success: '✅',
    error: '❌',
  }

  return (
    <div className={`px-6 py-2 text-sm ${statusStyles[status.type] || statusStyles.idle}`}>
      <div className="max-w-7xl mx-auto flex items-center gap-2">
        <span>{statusIcons[status.type] || statusIcons.idle}</span>
        <span>{status.message}</span>
        {status.type === 'loading' && (
          <span className="inline-block w-3 h-3 border-2 border-yellow-300 border-t-transparent rounded-full animate-spin ml-1"></span>
        )}
      </div>
    </div>
  )
}
