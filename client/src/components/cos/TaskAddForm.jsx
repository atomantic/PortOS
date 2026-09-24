import useTaskAddForm from '../../hooks/useTaskAddForm.js';
import TaskAddFormView from './TaskAddFormView.jsx';

export default function TaskAddForm(props) {
  const form = useTaskAddForm(props);
  return <TaskAddFormView form={form} compact={props.compact} queueFirst={props.queueFirst} />;
}
