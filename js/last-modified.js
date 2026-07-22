(function () {
    function formatLastModified(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return 'fecha no disponible';
        }

        return new Intl.DateTimeFormat('es-ES', {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(date);
    }

    document.addEventListener('DOMContentLoaded', function () {
        const headerContent = document.querySelector('header > div') || document.querySelector('header') || document.body;
        const lastModified = document.createElement('p');
        lastModified.className = 'last-modified';
        lastModified.textContent = 'Última modificación: ' + formatLastModified(document.lastModified);
        lastModified.style.color = '#667085';
        lastModified.style.fontSize = '0.85rem';
        lastModified.style.fontWeight = '600';
        lastModified.style.margin = '6px 0 0';

        headerContent.appendChild(lastModified);
    });
}());
